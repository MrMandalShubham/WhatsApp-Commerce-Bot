# WhatsApp Commerce Bot

WhatsApp-first ordering, payment, and delivery for a retail shop. Customers
browse and order in chat, share a delivery pin, pay by COD or payment link, and
track their own rider to the door.

Full design: [`whatsapp-commerce-implementation-plan-v2.md`](./whatsapp-commerce-implementation-plan-v2.md)

**Fulfilment is own-rider** — no courier aggregator. Riders collect cash, so COD
is tracked through to a rider cash settlement.

---

## Stack

| Layer | Local (now) | Production (later) |
|---|---|---|
| Database | `postgis/postgis:16-3.4` container | Supabase (Postgres + PostGIS) |
| Cache / queue | `redis:7-alpine` container | Redis service on Railway |
| API | NestJS in Docker | Railway (same Dockerfile, `prod` target) |
| Worker | BullMQ in Docker | Railway (same Dockerfile, `prod` target) |
| Object storage | — | Supabase Storage |

Nothing in application code references a Docker hostname. Moving to
Railway + Supabase is a change of `DATABASE_URL`, `DIRECT_URL`, and `REDIS_URL`.

---

## Prerequisites

- Docker Desktop (running)
- Node 22+ and pnpm — only needed to run Prisma commands from the host

## First run

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

Then create the schema and load sample data:

```bash
docker compose exec api pnpm --filter @wcb/db db:migrate --name init
```

```bash
docker compose exec api pnpm --filter @wcb/db db:seed
```

Check it came up:

```bash
curl http://localhost:3000/health/ready
```

Expect `{"status":"ok","db":true,"redis":true,"postgis":true}`.

## Everyday commands

```bash
docker compose logs -f api worker
```

```bash
docker compose exec api pnpm --filter @wcb/db db:studio
```

```bash
docker compose down
```

Add `-v` to `down` to drop the database volume and start clean.

---

## Connecting the WhatsApp webhook

Meta needs a public HTTPS URL — it will not call `localhost`.

1. Start a tunnel: `ngrok http 3000` (or `cloudflared tunnel --url http://localhost:3000`)
2. In the Meta app dashboard → WhatsApp → Configuration → Edit webhook:
   - **Callback URL**: `https://<your-tunnel>/webhooks/whatsapp`
   - **Verify token**: the value of `WHATSAPP_WEBHOOK_VERIFY_TOKEN` in `.env`
3. Subscribe to the `messages` field.
4. Send a WhatsApp message to your test number and watch `docker compose logs -f worker`.

The `GET` handshake and the `X-Hub-Signature-256` check are both implemented.
**Signature verification fails closed** — if `WHATSAPP_APP_SECRET` is unset, the
webhook rejects rather than trusting unsigned traffic. Set it before pointing
Meta at the tunnel.

---

## Layout

```
apps/
  api/        NestJS - webhooks, health, admin API (Phase 2+)
  worker/     BullMQ - inbound routing, sends, maintenance jobs
packages/
  db/         Prisma schema, migrations, seed
docs/
```

Admin panel, rider PWA, and tracking page arrive in Phases 2 and 4.

## Conversation flow (Phase 2)

The customer journey works end to end:

```
greeting -> opt-in -> categories -> products -> quantity
         -> cart review -> location pin -> landmark -> handover
```

`packages/core` holds the flow as a **pure function** — `step(input, context)`
returns replies and effects, touches no database, and sends nothing. That is
what makes 31 unit tests possible without Docker running:

```bash
pnpm --filter @wcb/core test
```

`packages/whatsapp` isolates the provider. With no access token configured it
falls back to a `StubProvider` that logs what would have been sent, so the whole
flow is developable before the Meta account exists. Set
`WHATSAPP_ACCESS_TOKEN` and the same code talks to the real Cloud API.

Behaviour worth knowing:

- opt-in is captured with the **exact wording shown**, and declining still
  allows browsing — consent only gates template notifications
- out-of-stock items are never listed; quantity buttons never exceed real stock
- adding to the cart **reserves stock with a 30-minute expiry**; the sweeper
  returns it if the customer wanders off
- `menu`, `cart`, `help` and `agent` work as commands from any state
- three invalid inputs in a row escalate to a human
- refusing the location permission offers a typed-address fallback rather than
  dead-ending the order
- Phase 2 ends at handover: a person confirms the order until payment lands in
  Phase 3

## Checkout and payments (Phase 3)

The flow now runs all the way to a real order:

```
... cart -> location pin -> landmark -> serviceability check
    -> payment mode -> order created -> COD confirmed | payment link -> paid
```

**Serviceability is a polygon test, not a PIN-code list.** The shared pin is
checked with `ST_Contains` against `service_areas`; the smallest matching area
wins so an inner zone can override a broad one. That one query decides
deliverability, the delivery fee, the minimum order value and the COD ceiling.

**COD eligibility is re-checked at the moment of choosing**, not only when the
buttons were drawn — a cart that grew past the ceiling in between is caught.

Order creation is a single transaction: line snapshots, stock reservations
handed from cart to order, cart closed, and the first status-history rows.

### Payment rules enforced

- only a **signature-verified callback** moves an order to `PAID` — a
  client-side redirect never does
- the callback **amount is checked against the order total**; a mismatch is
  audited and held for manual review rather than confirming the order
- a **replayed callback** is a no-op (provider event id is the idempotency key)
- a late `failed` event **cannot walk a paid order backwards** — the transition
  guard rejects it
- re-issuing a link creates a **new payment attempt row**; earlier attempts are
  never overwritten

Without Razorpay credentials the stack uses `StubPaymentProvider`, which issues
deterministic fake links and signs webhooks with `stub_webhook_secret` — so the
whole reconciliation path is testable before the merchant account exists.

```bash
npx tsx --test packages/core/src/money.test.ts packages/core/src/order.test.ts packages/core/src/flow/machine.test.ts packages/payments/src/razorpay.test.ts
```

64 unit tests, covering GST splits, COD rules, every status transition, and the
webhook signature cases.

### Working on the shared packages

`packages/core`, `packages/whatsapp` and `packages/payments` compile to `dist/`
(NestJS needs `emitDecoratorMetadata`, which only `tsc` emits, so the API cannot
consume raw TypeScript). After editing one of them:

```bash
pnpm build:packages
```

## Fulfilment and tracking (Phase 4)

Own riders, no courier aggregator. The whole last mile is ours:

```
packed -> assign rider -> start trip -> live tracking -> delivered
       -> COD collected -> rider cash settled with the shop
```

### Adding a rider

**Admin → Riders & cash → + New rider.** Name, phone, a sign-in email and a
cash limit. Leave the password blank and one is generated
(`copper-lantern-6535` style — readable enough to type on a phone keypad).

A rider is two rows created together: a `staff_users` record with the `RIDER`
role that they sign in with, and a `riders` record holding phone, vehicle and
cash ceiling. They are created and retired as a pair, so neither is left
orphaned.

**The password is shown once.** It is argon2-hashed and cannot be read back —
use **Password** on the row to issue a new one if it is lost.

Rules the panel enforces:

- duplicate phone or email refused, with which one clashed
- a bare 10-digit number is treated as Indian and stored as `+91…`
- **a rider mid-trip cannot be switched off** — the open stops would be
  stranded with nobody able to complete them
- **a rider still holding cash cannot be switched off** until it is settled
- switching a rider off also blocks their sign-in

### Rider API

| Method | Route | Notes |
|---|---|---|
| GET | `/rider/assignments` | stops with landmark, maps deep link, masked phone, cash to collect |
| POST | `/rider/assignments/:id/start` | opens the trip, mints the tracking token, notifies the customer |
| POST | `/rider/location` | GPS ping |
| POST | `/rider/assignments/:id/complete` | `DELIVERED` or `FAILED`, with POD and cash collected |
| GET | `/rider/cash` | what the rider is holding |
| POST | `/rider/cash/settle` | **staff only** — a rider cannot sign off their own cash |

### Live tracking

`GET /track/:token` is public and token-scoped. The token is random, expires in
6 hours, and is **revoked the moment the delivery closes**. The response carries
no order id, rider id, or phone number — the URL is shared over WhatsApp and
must not become a handle on the rest of the system.

Rider positions live in **Redis**, not Postgres: a ping every 10–15 seconds for
a whole trip is pure write load for data only ever read as "where are they
now". A sampled copy (once a minute) is persisted as the durable trail and
purged after 30 days. A fix older than 90 seconds is returned **with its
timestamp and a `stale` flag** rather than dropped, so the page can say "last
seen 4 minutes ago" instead of drawing a ghost.

### COD cash ledger

This is what Shiprocket was quietly doing for us. With own riders, cash moves
through individual people daily:

- amount due is recorded **at assignment**, before the rider leaves
- a rider is **blocked from new COD work** once undeposited cash would exceed
  their ceiling
- the rider records what they **actually collected** — partial payments are
  routine, so collected is never assumed to equal due
- settlement records a **shortfall** rather than absorbing it
- `GET /orders/riders/cash` shows every rider's outstanding cash

### Status notifications and the 24-hour window

This is where the window rule from section 2.1 of the plan actually bites.
Fulfilment updates fire long after the customer last messaged, so:

- **window open** → free-form text, no template needed
- **window closed** → an approved template, or nothing. A template that is not
  `APPROVED` is refused and the attempt is recorded as `FAILED /
  TEMPLATE_NOT_APPROVED` rather than sent — an unapproved send is a provider
  rejection and a mark against the number's quality rating.

Notification jobs are keyed `notify-<orderId>-<event>`, so a double status
write cannot send the customer two identical messages. Note the trade-off: a
genuine repeat of the same event (re-packed after a failed delivery) is
suppressed while that job id is still in the completed set.

## Apps and ports

| Port | App | Who uses it |
|---|---|---|
| 3000 | API + worker | — |
| 3001 | **Rider PWA** | riders, on a phone |
| 3002 | **Tracking page** | customers, opened from WhatsApp |
| 3003 | **Admin panel** | shop staff, at a desk |

```bash
docker compose up -d
```

## Tracking page (customer)

Public, token-scoped, light theme. The URL in the `out_for_delivery` template
opens here.

- **live map** with the rider and the destination, refreshed every 10 seconds
- **ETA in minutes**, straight-line distance inflated by a road factor — an
  honest "about 12 minutes" beats a false precision we are not paying a routing
  API for
- a fix older than 90 seconds shows **"Last seen 4 minutes ago"** rather than
  drawing a stale pin as current
- a four-step progress rail derived from the order's status
- polling **stops** once the order is delivered or the link dies — there is
  nothing more to see and the customer's battery is not ours to spend
- `robots: noindex` — the link travels over WhatsApp and should not be indexed
- an expired or revoked token gets a plain explanation, not an error page

⚠️ **Map tiles come from OpenStreetMap, which is not licensed for production
traffic.** Swap in Mapbox/MapTiler/Google before go-live — only the tile URL in
`apps/tracking/src/components/Map.tsx` changes.

## Admin panel (staff)

Five sections: **Dashboard**, **Orders**, **Products**, **Riders & cash**,
**Operations**.

- the dashboard's *needs attention* tiles turn **amber only when someone must
  act** — "riders on trip" stays neutral because it is information, not a problem
- the order drawer offers **only the transitions the state machine allows**, so
  staff are never presented a dead end
- **status changes are disabled until a reason is typed**, and the reason lands
  on the audit log
- cancelling a paid order asks for confirmation, because it marks a refund owed
- products show **on hand / held / available** separately, so a stock number
  that looks wrong can be explained by live carts
- Operations shows queue depth, the **dead-letter count**, replayable provider
  events, and the audit trail

## Rider app (PWA)

```bash
docker compose up -d rider
```

Runs at **http://localhost:3001**. Sign in with `rider@shop.local` /
`changeme123`. Installable to a phone home screen; works as a normal web page
otherwise.

Built for the actual conditions: one thumb, outdoors, in sunlight, on mobile
data.

- **dark by default** — most runs end after dark, and a bright screen is harder
  to read and worse for battery
- **56px minimum tap targets**, 17px+ input font (16px+ stops iOS zooming the
  page on focus)
- **the landmark is highlighted in amber**, because that is what riders
  actually navigate by
- **Navigate** opens Google Maps directions to the pin
- customer phone numbers arrive **masked** from the API
- respects the notch and home indicator via `env(safe-area-inset-*)`
- a **screen wake lock** during an active trip, re-acquired when the rider
  switches back to the app

### Location

`watchPosition` runs only while a trip is active, and pings are **throttled to
one every 12 seconds** — the browser fires far more often than we need, and
each ping costs the rider mobile data. A dropped ping is swallowed silently;
only a persistent failure surfaces, as staleness on the tracking page.

If the rider denies the permission the app says so plainly and **keeps
working** — deliveries still complete, only live tracking stops.

### Cash

The finish sheet pre-fills the amount due but leaves it **editable**, because
partial payments are routine. Entering less shows "Short by ₹20.00 — this is
recorded against the order"; entering more warns before continuing. The header
pill shows cash in hand and turns amber when the rider is over their ceiling.

### Offline

The service worker caches the app shell so the page opens without a
connection, but **API traffic is never cached** — a stale stop list or a stale
cash figure is worse than an honest error. Delivery completions are not queued
offline either: a rider must know whether a completion actually reached the
server, so those fail loudly.

## Operations and reporting (Phase 5)

### Reports

| Route | What it answers |
|---|---|
| `GET /reports/overview?days=N` | today vs period, status breakdowns, and an **attention** block |
| `GET /reports/daily?days=N` | orders, revenue and cancellations per day |
| `GET /reports/riders?days=N` | deliveries, success rate, outstanding cash per rider |
| `GET /reports/products?days=N` | what is actually selling |

The `attention` block is the useful one — it counts only things needing a
human: orders awaiting payment, failed payments, riders mid-trip, **webhooks
stuck over 5 minutes**, failed message sends, and low-stock products.

### Ops tooling

| Route | Purpose |
|---|---|
| `GET /ops/queues` | queue depths; the **failed** set is the dead-letter queue |
| `GET /ops/webhooks?state=stuck\|failed\|all` | events that never completed |
| `POST /ops/webhooks/:id/replay` | re-run a stored event through its processor |
| `GET /ops/messages/failed` | outbound sends the customer never got |
| `POST /ops/notifications/resend` | re-queue a status message |
| `GET /ops/audit` | recent staff actions, with actor emails resolved |

Replay clears `processedAt` first — otherwise the processors short-circuit and
the replay is a silent no-op. It **refuses to replay an unverified event**: a
payload that failed the signature check on the way in was never trusted, and
replaying it would be a route around that check.

Replays and resends use a one-off job id, deliberately bypassing the
`notify-<order>-<event>` dedup that protects normal traffic.

### Order actions

| Route | Rules |
|---|---|
| `POST /orders/:id/cancel` | **releases the stock reservations** |
| `POST /orders/:id/refund` | partial or full; cumulative refunds capped at the total |
| `POST /orders/:id/send-payment-link` | re-issues as a **new attempt row** |
| `PATCH /orders/:id/delivery-location` | staff pin correction, re-checks serviceability |

Cancelling without releasing reservations is how phantom stock-outs appear —
units vanish from `available` with no order left to consume them. Cancelling a
**paid** order requires `acknowledgeRefundDue: true`, so money owed cannot be
missed in a hurry, and it moves payment to `REFUND_PENDING`.

Pin correction keeps the PostGIS point in sync, marks the address
`STAFF_CORRECTED`, and reports whether the new pin is still inside a service
area — a correction cannot quietly move an order out of the delivery zone
without saying so.

## Admin API

JWT auth with argon2id password hashing. Authentication is **on by default** —
routes opt out with `@Public()` (health and webhooks only), so a new controller
is protected unless someone deliberately exposes it.

```bash
curl -s -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" -d '{"email":"owner@shop.local","password":"changeme123"}'
```

| Method | Route | Role |
|---|---|---|
| POST | `/auth/login` | public |
| GET | `/auth/me` | any staff |
| GET | `/products` | any staff |
| GET | `/products/:id` | any staff |
| POST | `/products` | OWNER, MANAGER |
| PATCH | `/products/:id` | OWNER, MANAGER |
| POST | `/products/:id/stock` | OWNER, MANAGER, OPERATOR |
| GET | `/categories` | any staff |
| POST | `/categories` | OWNER, MANAGER |
| PATCH | `/categories/:id` | OWNER, MANAGER |
| GET | `/customers` | any staff |
| GET | `/customers/:phone` | any staff |
| GET | `/customers/:phone/messages` | any staff |

Rules worth knowing:

- **stock is adjusted by a signed delta with a mandatory reason**, never set
  blindly — "why did we lose 12 units" is answerable from the audit log
- an adjustment **cannot drop stock below what live carts hold**; the error
  names the reserved quantity
- `reserved` is owned by the checkout flow and is never writable through the API
- every mutation writes an `audit_log` row with actor, before, after and reason
- creating a product also creates its inventory row — a product without one is
  invisible to the bot, which reads availability as `onHand - reserved`
- lists are **cursor-paginated**, not offset: an admin scrolling while orders
  arrive would otherwise see duplicates and skips
- `/customers/:phone` reports whether the **24-hour service window is open**, so
  a support agent knows if they can reply free-form or need a template

Seed credentials are `owner@shop.local` / `changeme123`; override with
`SEED_ADMIN_PASSWORD`. Change them before anything leaves your machine.

## What runs today

- `GET /webhooks/whatsapp` — Meta verification handshake
- `POST /webhooks/whatsapp` — signature-verified, idempotent, stores the raw
  payload and enqueues it
- `GET /health` and `GET /health/ready` — liveness and readiness (db, redis, postgis)
- Worker consumes inbound events, upserts the customer, logs the message, and
  records the 24-hour service window
- Repeatable maintenance jobs: release expired stock reservations, expire
  abandoned carts, revoke stale tracking links, purge rider pings (30 d) and
  webhook events (90 d)

## Data model

29 tables. See [`packages/db/prisma/schema.prisma`](./packages/db/prisma/schema.prisma).

Rules the schema enforces:

- money is an integer in **paise** with an explicit currency — never a float
- order lines **snapshot** title, price, tax and HSN at order time
- GST rate and HSN are first-class, not retrofitted
- every stock reservation has an `expiresAt`, and a job releases it
- coordinates are PostGIS `geography` columns, queried with `$queryRaw`
- three independent status fields — payment, fulfilment, order — because a COD
  order ships unpaid
- COD cash is tracked from collection through to rider settlement, with
  shortfalls recorded rather than absorbed

---

## Moving to Railway + Supabase

1. Create the Supabase project (**Mumbai / ap-south-1**), enable the `postgis`
   extension.
2. Set `DATABASE_URL` to the **pooler** connection (port 6543) with
   `?pgbouncer=true&connection_limit=1`, and `DIRECT_URL` to the **direct**
   connection (port 5432). Prisma needs both — migrations use the direct one.
3. On Railway, create one service per app pointing at
   `apps/api/Dockerfile` and `apps/worker/Dockerfile` with target `prod`,
   plus a Redis service.
4. Copy the `.env` values into Railway variables.
5. Run `pnpm --filter @wcb/db db:deploy` once against the Supabase database.

The Dockerfiles already carry a `prod` target, so no build changes are needed.
