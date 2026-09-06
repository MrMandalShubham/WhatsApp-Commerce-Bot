# WhatsApp Commerce Bot — Implementation Plan v2

**Version:** 2.0
**Supersedes:** `whatsapp-commerce-implementation-plan.md` (v1)
**Status:** Draft for client review

## Changelog from v1

| # | Change | Reason |
|---|---|---|
| 1 | Added **Platform Prerequisites & Constraints** section | v1 omitted the 24-hour customer service window, opt-in rules, business verification, and messaging tiers — all go-live blockers |
| 2 | Added **Location & Delivery Precision Layer** | New requirement: capture delivery pin in chat, live rider tracking |
| 3 | Replaced two conflicting status lists with **three orthogonal state machines** | v1 defined incompatible enums in two different sections |
| 4 | Expanded data model from 14 to 26 tables | v1 lacked carts, refunds, tax, consent, idempotency, geo, and template registry |
| 5 | Added **money, tax, and price-snapshot design rules** | GST is mandatory for Indian retail invoicing; v1 had no tax fields at all |
| 6 | Added **cost model** section | v1 had no unit economics; required before quoting a client |
| 7 | Added **BSP vs direct Cloud API** decision point | Foundational architecture choice, silently assumed in v1 |
| 8 | Added Redis, object storage, and rider PWA to architecture | BullMQ requires Redis; product images need object storage — neither appeared in v1 |
| 9 | Added phase durations and a parallel compliance track | v1 had six phases with no estimates or dependency ordering |
| 10 | Added data retention / DPDP policy | v1 stored raw PII webhooks indefinitely with no purge rule |
| 11 | Removed unresolved `[cite:N]` markers | They referenced a bibliography that did not exist in the document |

---

## 1. Project Objective

Build a WhatsApp-first ordering system for a retail shop where customers browse products, place orders, choose online payment or cash on delivery, share a precise delivery location, and receive fulfilment and delivery tracking updates inside WhatsApp wherever the platform permits.

This is **not** a pure "everything lives natively inside chat" system, and it should not be sold as one. The deliverable is a WhatsApp-first commerce flow backed by a custom order management backend, payment-link integration, geo-validated delivery capture, and courier tracking pushed back into WhatsApp through approved templates and webhook-driven events.

---

## 2. Platform Prerequisites & Constraints

**This section did not exist in v1 and is the most important addition.** Everything below is an external dependency with lead time. Nothing from Phase 2 onward can go live until these clear.

### 2.1 The 24-Hour Customer Service Window

This single rule shapes the entire messaging architecture.

- When a customer messages the business, a **24-hour customer service window** opens.
- **Inside the window:** the business may send free-form messages — text, interactive menus, location messages, location requests, media. No template approval needed.
- **Outside the window:** the business may send **only pre-approved template messages**.

Consequences for this project, all of which must be designed for explicitly:

- Every catalogue browse, cart, address capture, and checkout interaction happens **inside** the window. These can be interactive and free-form. Good.
- Every post-order notification — `packed`, `shipped`, `out_for_delivery`, `delivered`, payment reminders — almost always fires **outside** the window. These **must** be approved utility templates.
- **Outbound location messages are free-form**, therefore they only work inside an open window. Rider location cannot be pushed as a raw location message to a customer who has gone quiet. Outside the window it must be a template carrying a tracking URL. This constraint drives the design in Section 7.
- Any customer reply re-opens the window for another 24 hours. A template with a quick-reply button is the standard way to deliberately re-open a window.

### 2.2 Opt-In

Meta requires demonstrable opt-in before sending template messages. v1 had no opt-in capture at all.

- Capture opt-in explicitly at first contact, recording **timestamp, source, channel, and the exact wording shown**.
- Store in a dedicated `customer_consents` table (Section 9), not as a boolean on `customers` — you need history, not current state.
- Provide an opt-out keyword path (`STOP`), honour it immediately, and suppress all non-transactional templates for opted-out numbers.
- Opt-out should not block transactional order updates the customer has a legitimate interest in receiving — but confirm this reading with the client's legal position in Phase 0.

### 2.3 Account Onboarding Lead Times

"Connect the WhatsApp Business Cloud API" is not a one-day Phase 1 task. It decomposes into:

| Prerequisite | Typical lead time | Owner |
|---|---|---|
| Meta Business verification (documents, business proof) | 1–3 weeks, can bounce | Client + us |
| WhatsApp Business Account creation | 1 day | Us |
| Phone number registration (must not be active on consumer WhatsApp) | 1 day, blocked if the number is in use | Client |
| Display name approval | 2–7 days, can be rejected | Client |
| Message template approval, per template, per language | 1–3 days each, can be rejected | Us |
| Payment gateway KYC / merchant onboarding | 1–2 weeks | Client |
| Courier account + API credentials | 1–2 weeks | Client |

**These run as a parallel track starting on day one of Phase 0.** They are the critical path, not the code.

### 2.4 Messaging Limits

New numbers start rate-limited on unique customers contacted per rolling 24 hours (commonly 1K, tiering up to 10K, 100K, and unlimited based on quality rating and volume). Plan launch volume against the starting tier, and monitor the quality rating — repeated blocks or low-quality flags will cap or restrict the number.

### 2.5 WhatsApp Commerce Policy

The catalogue must comply with Meta's commerce policy. Restricted categories (alcohol, tobacco, supplements in some markets, medical devices, and others) will cause catalogue rejection or account action. **Audit the client's actual product list against the current policy in Phase 0**, before any catalogue work is scheduled.

### 2.6 Verification Checklist for Phase 0

Every item below is a stated assumption in this plan that must be re-confirmed against current Meta documentation before build, because platform capability and pricing both change:

- [ ] Current template pricing model and per-message rates for the target market
- [ ] Which utility templates, if any, are free inside an open customer service window
- [ ] Commerce policy status of every product category the client sells
- [ ] Whether native in-chat payments are available and approved for this account and region
- [ ] Whether any form of continuous live-location streaming has become available to the Business Platform (see Section 7.1)

---

## 3. Target Customer Journey

1. Customer messages the business on WhatsApp.
2. **Opt-in is captured** before any template messaging is promised.
3. Customer browses products via catalogue, list messages, and buttons.
4. Customer selects items and confirms quantities.
5. **Customer shares delivery location via a location request button**, and confirms or corrects the reverse-geocoded address.
6. System validates serviceability and COD eligibility **against the shared coordinates**, not just a typed PIN code.
7. Customer chooses COD or online payment.
8. Online payment sends a secure payment link; COD places the order directly.
9. Backend creates the order, reserves stock with an expiry, and sends confirmation.
10. On dispatch, the customer receives a template with a **live tracking link**; inside an open window they additionally receive the rider's location as a map message.
11. Status updates flow through `packed`, `shipped`, `out_for_delivery`, `delivered` as approved templates.

---

## 4. Product Scope

Included in the first production version:

- Product catalogue browsing in WhatsApp
- Cart and order-intent capture through interactive flows
- Customer profile capture: number, name, address, delivery notes
- **Delivery location pin capture and geo-validation**
- **Live rider tracking via a hosted tracking page linked from WhatsApp**
- Payment choice: COD or online payment link
- Order management and fulfilment tracking in an admin panel
- WhatsApp notifications for confirmation, shipping, delivery, and exceptions
- Order lookup, order status, and human escalation

Deliberately excluded from v1: AI-driven free-form ordering. Structured menus and guided flows are safer, faster to deliver, easier to test, and more reliable in live retail operations. This judgement from v1 is retained without change.

---

## 5. Architecture

### 5.1 Decision Required: BSP vs Direct Cloud API

v1 assumed direct Cloud API without stating it. Decide explicitly in Phase 0:

| | Direct Meta Cloud API | Business Solution Provider |
|---|---|---|
| Per-message cost | Meta rates only | Meta rates + BSP markup |
| Template submission | Self-managed via API / Manager | Often assisted, sometimes faster |
| Engineering effort | Higher — we build everything | Lower — SDKs, dashboards, retries |
| Vendor lock-in | None | Moderate |
| Support during incidents | Meta support only | Named BSP support |

**Recommendation:** direct Cloud API, with the integration isolated behind a `WhatsAppProvider` interface (Section 5.3) so a BSP can be swapped in without touching business logic if support becomes a problem.

### 5.2 Core Components

| Component | Responsibility |
|---|---|
| WhatsApp Business Platform | Messaging, catalogue display, interactive replies, location requests, templates, webhooks |
| Commerce Backend (API) | Product data, cart logic, order creation, payment mode, stock, status transitions |
| Worker | Queued jobs: template sends, courier polling, reservation expiry, retries, dead-letter handling |
| Payment Service | Payment link creation, callback verification, reconciliation, refunds |
| Logistics Service | Shipment booking, AWB storage, delivery status sync, status normalisation |
| **Geo Service** | Reverse geocoding, serviceability polygon checks, distance and ETA calculation, address deduplication |
| **Rider App (PWA)** | Rider authentication, assigned stops, live GPS reporting, proof of delivery |
| **Tracking Page** | Public, token-scoped map page showing rider position and order status |
| Admin Panel | Product management, order dashboard, fulfilment actions, support overrides |
| PostgreSQL + PostGIS | Primary datastore; PostGIS for coordinates and service-area polygons |
| **Redis** | BullMQ queue backend, session cache, rider position cache, rate limiting |
| **Object Storage** | Product images, shipping labels, proof-of-delivery photos |

Redis and object storage were missing from v1's component list despite BullMQ and product images both being specified.

### 5.3 Technology Stack

- **Backend:** Node.js with NestJS — module boundaries map cleanly onto the layers below
- **Database:** PostgreSQL 16 with **PostGIS** (required for the location layer)
- **ORM:** Prisma, with raw SQL for PostGIS predicates
- **Queue:** BullMQ on Redis
- **Admin Panel:** Next.js
- **Rider App:** Next.js PWA using `navigator.geolocation.watchPosition`
- **Monorepo tooling:** pnpm workspaces + Turborepo
- **Hosting:** DigitalOcean or AWS
- **WhatsApp:** Cloud API, direct
- **Payments (India):** Razorpay payment links
- **Logistics:** Shiprocket or Delhivery, decided in Phase 0 by client geography
- **Maps / geocoding:** Google Maps Platform (Geocoding + Maps JS) or Mapbox
- **Observability:** structured JSON logs with correlation IDs, Sentry, order event audit table, webhook failure tracking

**Provider isolation rule:** every external provider sits behind an interface in `packages/integrations` — `WhatsAppProvider`, `PaymentProvider`, `LogisticsProvider`, `GeoProvider`. No business logic imports a vendor SDK directly. This is what makes the "swap the courier" and "swap the BSP" claims actually true rather than aspirational.

---

## 6. Functional Modules

### 6.1 WhatsApp Interaction Layer

- Receive inbound messages via webhook subscription; respond to the `GET` verification handshake
- Verify the payload signature on every inbound request
- Map replies to browsing, cart updates, location capture, address capture, and order placement
- **Enforce window state:** before every outbound send, determine whether the 24-hour window is open. Free-form sends outside the window must be rejected at the service boundary, not discovered as a provider error in production.
- Send approved templates for utility notifications
- Route ambiguous or failed cases to a human operator

### 6.2 Product Catalogue Layer

- Internal product records as the source of truth
- Map internal products to WhatsApp catalogue items
- Stock availability, variant pricing, images, categories
- Suppress ordering on out-of-stock products
- Image upload to object storage, with the CDN URL synced to the catalogue

### 6.3 Order Management Layer

- Create cart, then draft order
- Validate product, price, quantity, address, and **serviceability of the delivery coordinates**
- Confirm payment mode against COD eligibility rules
- Generate the final order record with a price and tax snapshot
- Drive the three state machines defined in Section 10

### 6.4 Payment Layer

- Generate a payment link scoped to a specific order
- Capture and **signature-verify** gateway callbacks
- Update payment state; never trust a client-side redirect as proof of payment
- Expire unpaid links on a timer
- Allow staff to re-issue payment links from the admin panel
- Each retry creates a **new** payment attempt row; never overwrite prior attempts
- Record refunds against a dedicated `refunds` table

### 6.5 Logistics & Tracking Layer

- Create a shipment after order confirmation
- Store courier name, shipment ID, AWB, label URL, tracking URL
- Poll or receive courier status updates
- Normalise courier statuses into internal fulfilment states
- Trigger WhatsApp notifications on normalised transitions

### 6.6 Location & Delivery Precision Layer

Specified in full in Section 7.

### 6.7 Admin Operations Layer

- Manage products, prices, variants, inventory
- Order dashboard with search, filter, and pagination
- Mark packed / shipped; trigger shipment creation
- **View the delivery pin on a map, and correct it when the customer pinned the wrong spot**
- Assign a rider and monitor live rider positions
- Re-send notification templates; retry failed sends
- Search customer by phone or order ID
- Manual status override with a mandatory reason, written to the audit log

---

## 7. Location & Delivery Precision Layer

The core delivery-accuracy feature. Typed Indian addresses are unreliable; a coordinate pin plus a typed address is dramatically better for last-mile success.

### 7.1 What the Platform Actually Supports

Verified against Meta's documentation:

| Capability | Supported | Direction | Notes |
|---|---|---|---|
| Location request message | **Yes** | Business → customer | Interactive `location_request_message`: body text plus a "Send location" button |
| Location message from customer | **Yes** | Customer → business | Webhook delivers a `location` message; `latitude` and `longitude` always present, `name` and `address` only when the pin maps to a known place |
| Location message to customer | **Yes** | Business → customer | Free-form — **only sendable inside an open 24-hour window** |
| **Continuous live-location streaming** | **Not a documented capability** | — | Meta documents location messages as single snapshots. Consumer-app live location is not exposed to the Business Platform as a stream. |

**Design consequence:** we get an accurate one-shot pin from the customer, which is what actually matters for delivery. We do **not** get a live feed of the customer's movement, and we must not promise the client one. Live *rider* tracking is delivered through our own infrastructure instead, linked from WhatsApp — described in 7.3.

Item 5 of the Phase 0 verification checklist re-tests this assumption before build starts.

### 7.2 Customer Pin Capture — Inbound

At the address step of checkout:

1. Send an interactive `location_request_message`: *"Please share your delivery location so our rider can find you quickly."*
2. Customer taps **Send location** and confirms a pin.
3. Webhook returns a `location` message with `latitude`, `longitude`, and optionally `name` / `address`.
4. **Reverse geocode** the coordinates via the Geo Service.
5. Show the resolved address back to the customer for confirmation, with buttons: **Confirm** / **Edit**.
6. Always additionally capture free-text **landmark and delivery notes** — floor, gate colour, "opposite the temple". Reverse geocoding does not produce these, and riders depend on them.
7. Persist coordinates, accuracy, resolved address, typed corrections, and `source` (`pin`, `typed`, `geocoded`, `staff_corrected`) on `customer_addresses`.

**Fallback path, mandatory:** some customers deny location permission or share the wrong pin. Always offer a typed-address route that forward-geocodes to coordinates. The flow must never dead-end on a refused permission.

### 7.3 Rider Live Tracking — Outbound

Since WhatsApp cannot stream live location, the rider PWA does:

1. Admin assigns the order to a rider → row in `rider_assignments`.
2. Rider opens the PWA and starts the trip. `watchPosition` reports every 10–15 seconds while the app is foregrounded.
3. Pings hit `POST /rider/location` → latest position cached in **Redis** (hot read), with sampled writes to `rider_location_pings` (audit trail). Do not write every ping to Postgres.
4. On `out_for_delivery`, generate a `tracking_links` row: a **signed, short-lived, single-order token**. Never expose a raw order ID or rider ID in the URL.
5. Send the customer the `out_for_delivery` **template** containing a URL button to `https://track.<domain>/t/<token>`.
6. The tracking page shows rider position, order status, an ETA, and a masked rider contact number. It polls the hot cache.
7. **If the 24-hour window happens to be open**, additionally send a native WhatsApp location message showing the rider's current position — a nice in-chat touch, but never the primary mechanism, because it usually will not be available.
8. On delivery, invalidate the token immediately. Tracking links must not remain live after the order completes.

### 7.4 Geo-Validation Rules

The pin is not just for the rider — it enforces business rules that v1 could not:

- **Serviceability:** `ST_Contains(service_area.polygon, delivery_point)`. Polygons are far more accurate than PIN-code lists, which routinely straddle serviceable and non-serviceable areas.
- **COD eligibility:** restrict by polygon, order value, and product type. v1 specified COD PIN-code restriction with no data to enforce it against.
- **Delivery fee banding:** by road distance or straight-line distance from the shop.
- **Address deduplication:** a new pin within ~25 m of an existing address for the same customer is treated as the same address, not a new one. Prevents address-list sprawl on repeat orders.
- **Suspicious-distance check:** flag for manual review when the pin is implausibly far from the typed PIN code — usually a mis-pinned map, occasionally fraud.

### 7.5 Privacy Rules for Location Data

Location is sensitive personal data and must be handled as such:

- Purpose-limited to fulfilling the order the customer shared it for
- **Rider position pings retained 30 days, then purged** — they are an operational audit trail, not a business record
- Customer delivery pins retained with the address record, deletable on request
- The customer sees the rider; **the rider never sees customer location history**, only the current stop
- Rider phone numbers masked on the tracking page
- Rider GPS collection runs only during an active assigned trip, never in the background outside a trip, and this must be stated plainly in the rider app

---

## 8. WhatsApp Conversation Design

### 8.1 Main Flow

1. Greeting **+ opt-in capture**
2. Browse categories
3. View products
4. Select quantity
5. Confirm cart
6. **Share delivery location** (location request → reverse geocode → confirm)
7. **Capture landmark and delivery notes**
8. Serviceability and COD eligibility check
9. Choose payment mode
10. Confirm order
11. Send payment link if prepaid
12. Send order confirmation

### 8.2 Post-Order Flow

- Customer sends "track order"
- System identifies the recent order by phone, or asks for an order ID
- System returns current status plus the tracking link if a shipment or rider assignment exists

### 8.3 Session Rules

v1 listed "customer reopens conversation after long inactivity" as a test case but never designed for it.

- Sessions expire after **30 minutes** of inactivity; the cart survives, the flow step does not
- On re-entry after expiry, greet and offer to resume the saved cart or start over — never silently resume mid-step
- Cart abandonment at 24 hours releases the stock reservation
- Three consecutive unrecognised inputs escalate to a human

### 8.4 Human Handover Conditions

Product not found · custom pricing request · address or serviceability validation failure · payment mismatch · complaint or return request · three consecutive failed inputs · location permission refused twice.

---

## 9. Data Model

26 tables. Additions to v1 are marked **NEW**.

| Table | Purpose |
|---|---|
| products | Master data: title, SKU, category, price, **HSN code**, image, active flag |
| product_variants | Variant pricing and stock |
| inventory | On-hand and reserved counts |
| **inventory_reservations** | **NEW** — reservation with `expires_at`; released by a sweeper job |
| customers | Identity keyed by WhatsApp phone number |
| **customer_consents** | **NEW** — opt-in/opt-out history: timestamp, source, channel, wording shown |
| customer_addresses | Addresses **+ `location geography(Point,4326)`, accuracy, source, landmark, notes** |
| **service_areas** | **NEW** — delivery polygons, COD eligibility, delivery fee band |
| **carts** | **NEW** — active cart before order conversion; v1 referenced cart logic with no cart entity |
| orders | Header, totals, **tax totals**, payment mode, three status fields, timestamps |
| order_items | Line items with **unit price, tax rate, and product title snapshotted at order time** |
| payments | Attempts, gateway IDs, status, amount, raw callback payload |
| **refunds** | **NEW** — v1 had `refund_pending` / `refunded` states with nothing to record against |
| shipments | Courier, shipment ID, AWB, label URL, tracking URL |
| **shipment_events** | **NEW** — raw courier event stream, separate from normalised status |
| **rider_assignments** | **NEW** — rider, order, trip start/end, proof of delivery |
| **rider_location_pings** | **NEW** — sampled GPS trail, 30-day retention |
| **tracking_links** | **NEW** — signed token, order scope, expiry, revocation |
| whatsapp_sessions | Flow state, last step, context snapshot, expiry |
| whatsapp_messages | Inbound and outbound log with provider message IDs and delivery receipts |
| **message_templates** | **NEW** — template name, language, category, approval status, variable schema |
| webhook_events | Raw payloads for replay and audit, with retention |
| **idempotency_keys** | **NEW** — idempotency was an NFR in v1 with no storage behind it |
| order_status_history | Immutable transition log |
| staff_users | Admin and operations RBAC |
| **audit_log** | **NEW** — actor, action, target, before/after, reason for every manual override |

### 9.1 Design Rules

Carried from v1:
- Order status history is immutable
- Store raw webhook payloads for replay
- Separate shipment status from payment status
- Normalise external provider states into internal business states
- Track every outbound template send and its delivery outcome

Added in v2:
- **Money as integer minor units** (paise) with an explicit currency column. Never floats.
- **Snapshot price, tax rate, and title onto `order_items` at order time.** Never read them back through the product FK — a later price change must not rewrite history.
- **Tax is first-class.** GST rate, CGST/SGST/IGST split, and HSN codes are mandatory for Indian retail invoicing. Retrofitting tax after Phase 3 is expensive.
- **Every reservation has an expiry.** No unbounded holds.
- **Coordinates as PostGIS `geography(Point, 4326)`**, never as a pair of loose floats — you need spatial indexes and distance predicates.
- **Every external write carries an idempotency key.**
- **Retention is declared per table**, not left implicit (Section 11.4).

---

## 10. State Machines

v1 defined two contradictory status lists in different sections. v2 replaces both with **three independent fields**, plus one derived value for display.

### 10.1 `payment_status`
`not_required` (COD) → `pending` → `link_sent` → `paid` → `failed` → `expired` → `refund_pending` → `refunded`

### 10.2 `fulfillment_status`
`unfulfilled` → `confirmed` → `packed` → `shipped` → `out_for_delivery` → `delivered` → `failed_delivery` → `returned`

### 10.3 `order_status`
`draft` → `placed` → `confirmed` → `completed` → `cancelled`

### 10.4 Derived Display Status

The customer-facing label is **computed** from the three fields above — it is never a stored fourth source of truth. This is precisely the mixed-logic trap that v1's own design rule warned against while its two status lists violated it.

**Transition rules:**
- Every transition is guarded; illegal transitions raise rather than silently no-op
- Every transition writes to `order_status_history` with actor and reason
- Only a verified gateway callback or an explicit admin approval may set `payment_status = paid`
- `fulfillment_status` may advance independently of `payment_status` — a COD order ships unpaid, which is exactly why they are separate fields

---

## 11. Non-Functional Requirements

### 11.1 Reliability
- Webhook idempotency for every provider, backed by `idempotency_keys`
- Retry with exponential backoff on transient failures
- Dead-letter queue with an admin-visible replay tool
- Raw event storage for replay
- **SLOs:** webhook ack under 500 ms p95; order creation under 2 s p95; 99.5% monthly uptime. v1 specified "load and retry testing" with no target to pass or fail against.

### 11.2 Security
- Verify provider signatures on every webhook — WhatsApp, payment, logistics
- RBAC on the admin panel; rider role strictly scoped to assigned stops
- Secrets in a managed secret store, never committed to source
- HTTPS everywhere; HSTS on the tracking page
- Tracking tokens: signed, short-lived, single-order, revoked on delivery
- Rate limiting on all public endpoints
- Audit log for every manual override

### 11.3 Scalability
Provider-agnostic module boundaries (Section 5.3) so payment, logistics, or messaging providers can change without a rewrite. Worker processes scale independently of the API.

### 11.4 Data Retention (India DPDP Act 2023)

v1 stored raw PII webhook payloads indefinitely with no purge policy, which conflicts with its own security posture.

| Data | Retention |
|---|---|
| Raw webhook payloads | 90 days, then purge |
| Rider location pings | 30 days, then purge |
| WhatsApp message log | 12 months |
| Orders, payments, invoices | 8 years (statutory financial record retention) |
| Customer profile and addresses | Until deletion requested, subject to statutory holds |

Provide a documented customer data deletion procedure. Confirm the exact statutory retention period with the client's accountant in Phase 0.

### 11.5 Observability
- Structured JSON logs with a correlation ID threaded from inbound webhook through to outbound send
- Sentry for exception tracking
- Dashboard counters: new orders, paid orders, failed payments, shipment delays, webhook failures, template rejections, **riders on trip**
- Alerting on provider downtime, retry exhaustion, DLQ depth, and WhatsApp quality-rating drops

---

## 12. API Design

### 12.1 Provider-Facing

- `GET /webhooks/whatsapp` — **verification handshake; missing from v1 and required by Meta**
- `POST /webhooks/whatsapp` — inbound events, signature-verified
- `POST /webhooks/payment` — gateway callbacks, signature-verified
- `POST /webhooks/logistics` — courier status updates

### 12.2 Admin (authenticated, RBAC, paginated)

- `GET|POST /products`, `PATCH /products/:id`
- `GET /orders` — filter by status, date, phone; cursor-paginated
- `GET /orders/:id`
- `POST /orders/:id/send-payment-link`
- `POST /orders/:id/create-shipment`
- `POST /orders/:id/change-status` — requires a reason
- `POST /orders/:id/cancel`
- `POST /orders/:id/refund`
- `PATCH /orders/:id/delivery-location` — **staff correction of a mis-pinned location**
- `POST /orders/:id/assign-rider`
- `GET /customers/:phone`
- `GET /service-areas`, `POST /service-areas`
- `GET /reports/orders`

### 12.3 Rider (authenticated, rider role)

- `GET /rider/assignments`
- `POST /rider/location` — GPS ping
- `POST /rider/assignments/:id/complete` — proof of delivery

### 12.4 Public (token-scoped, no auth)

- `GET /track/:token` — order status and rider position; rate-limited, token expires on delivery

**Conventions:** cursor pagination on all list endpoints, `Idempotency-Key` header on all mutating admin endpoints, RFC 7807 `problem+json` error bodies.

---

## 13. Payment Strategy

Hybrid, unchanged in principle from v1:

- **COD** for low-friction checkout
- **Online payment link** for prepaid orders
- Native in-chat payments deferred until confirmed available and approved for this account and region

### Payment Rules
- COD restricted by **service-area polygon**, order value, and product type
- Payment links expire automatically; expiry window configurable per client
- No order reaches `paid` without a verified callback or explicit admin approval
- Retries create new attempt records; prior attempts are never overwritten
- Refunds are recorded in `refunds`, reconciled against the gateway, and confirmed to the customer by template

---

## 14. Delivery & Tracking Strategy

Normalised fulfilment states from Section 10.2 drive customer notifications. Each transition may trigger a utility template, subject to approval and the window rules in Section 2.1.

**Template inventory to submit in Phase 0** — each needs approval, each per language:

1. Order confirmation
2. Payment reminder / link re-send
3. Payment received
4. Order packed
5. Shipped, with tracking link
6. **Out for delivery, with live tracking link button**
7. Delivered
8. Failed delivery attempt, with reschedule quick-reply
9. Order cancelled
10. Refund processed

If the client serves Hindi or regional-language customers, **every template above needs a separate approved translation**. Confirm the language list in Phase 0 — this doubles or triples the approval workload, and v1 did not consider it at all.

---

## 15. Cost Model

Absent from v1, and required before quoting a client.

### 15.1 Per-Order Variable Cost

| Item | Basis |
|---|---|
| WhatsApp utility templates | Per message, per market. **Confirm current rates** — Meta's pricing model has changed more than once, most recently moving from conversation-based to per-message billing. Budget for 3–5 templates per order. |
| Payment gateway | ~2% MDR on prepaid orders |
| Courier | Per shipment, weight and zone dependent |
| Geocoding | Per reverse-geocode call — cache aggressively, geocode once per address, never per page view |
| Maps on tracking page | Per map load — a live-tracking page that reloads a map every few seconds is a real cost centre; poll data, not maps |

### 15.2 Fixed Monthly

Hosting (API, worker, admin, Postgres, Redis), object storage and egress, Sentry, domain and TLS.

### 15.3 Notes

- Free-form messages inside an open service window are the cheap path. **Design conversations to complete inside the window** — this is a cost decision, not only a UX one.
- Every avoidable template send is a recurring per-order cost. Consolidate notifications; do not send a template for every micro-status.

---

## 16. Delivery Phases

Durations assume one backend engineer, one frontend engineer, and a part-time QA resource. **Track A (compliance) runs in parallel from day one and is the critical path.**

### Track A — Compliance & Accounts (Weeks 1–6, parallel)
Meta Business verification · WhatsApp Business Account · number registration · display name approval · **all 10 templates submitted by end of week 2** · payment gateway KYC · courier account setup.

*Templates submitted in week 2 means rejections surface in week 3 and are resolvable. Templates submitted in Phase 4 means a delayed go-live. v1's risk table identified this and its phase plan did not act on it.*

### Phase 0 — Discovery & Requirement Freeze (Weeks 1–2)
Catalogue structure · delivery geography **as polygons, not a PIN list** · COD rules · courier partner · return and cancellation policy · daily fulfilment ownership · **language list** · **product categories audited against commerce policy** · **Section 2.6 verification checklist completed**.
**Deliverables:** approved BRD, final order lifecycle, template list, provider shortlist, service-area polygons.

### Phase 1 — Foundation (Weeks 2–4)
Repo and environments · PostgreSQL + PostGIS schema · NestJS skeleton · Redis and BullMQ · admin auth and RBAC · webhook endpoints including the `GET` handshake · signature verification · Sentry and structured logging.
**Deliverables:** running backend, migrations, admin shell, webhooks verified against live Meta events.

### Phase 2 — Catalogue & Customer Flow (Weeks 4–7)
Product CRUD with image upload · catalogue browse flow · session storage and expiry · cart and draft order · **opt-in capture**.
**Deliverables:** product CRUD, guided browse flow, session management, cart persistence.

### Phase 3 — Location, Checkout & Payment (Weeks 7–11)
**Location request flow · reverse geocoding · service-area validation · address deduplication · landmark capture** · COD eligibility · Razorpay payment links · callback verification · reconciliation · tax calculation.
**Deliverables:** full checkout with geo-validated delivery, payment attempts and reconciliation, order confirmation.

### Phase 4 — Fulfilment & Tracking (Weeks 11–15)
Shipment records · courier integration · status normalisation · **rider PWA · live tracking page · signed tracking tokens** · notification automation.
**Deliverables:** shipment booking, tracking sync, rider app, live tracking, delivery templates firing on transitions.

### Phase 5 — Admin Hardening (Weeks 15–17)
Order dashboard with search and filters · **map view and pin correction** · rider assignment and monitoring · manual overrides with audit · resend and retry tooling · reports.
**Deliverables:** production-ready admin panel, operations controls, support tooling.

### Phase 6 — QA, UAT & Go-Live (Weeks 17–20)
End-to-end testing · template flow validation · payment and refund edge cases · load and retry testing against the Section 11.1 SLOs · **rider app field testing on real routes with real GPS** · staff training.
**Deliverables:** UAT checklist, deployment runbook, incident response notes, go-live signoff.

**Total: ~20 weeks**, gated on Track A clearing. If Meta verification stalls, everything from Phase 2 onward can still be built and tested against the sandbox — but nothing goes live.

---

## 17. Testing Plan

### Functional
Browse flow · quantity selection · **location share and reverse geocode** · **location permission denied fallback** · address confirmation and correction · COD placement · online payment success and failure · shipment creation · rider assignment and tracking link · track-order request · delivered notification.

### Edge Cases
Duplicate webhooks · expired payment links · **stock exhausted during checkout** · courier status arriving before payment sync · **session reopened after expiry with a live cart** · overlapping orders from one number · **pin outside all service areas** · **pin far from the typed PIN code** · **rider GPS lost mid-trip** · **customer messages outside the 24-hour window** · **template rejected after go-live** · refund on a partially shipped order.

### Provider Testing
Contract tests against mocked WhatsApp, payment, and courier providers · Razorpay test mode · WhatsApp test number · replay of captured production webhooks against staging.

### Operational
Admin retries a failed notification · manual order correction · **staff corrects a wrong delivery pin** · payment mismatch handling · bot-to-human handover.

### Load
Sustained inbound webhook burst at expected peak × 3 · queue depth recovery after a provider outage · tracking page under concurrent viewers.

---

## 18. Risks & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Meta business verification delay | Go-live blocked | Track A starts week 1; client document checklist issued day 1 |
| Template approval delays or rejection | Notifications dead on arrival | Submit all templates by week 2; keep spare copy variants ready |
| **Customer denies location permission** | Checkout dead-ends | Mandatory typed-address fallback with forward geocoding (7.2) |
| **Client expects WhatsApp-native live location** | Expectation gap at UAT | Documented in 7.1 and re-verified in Phase 0; tracking-page approach agreed in writing at kickoff |
| **Rider GPS unreliable or app backgrounded** | Tracking gaps | Show last-known position with an explicit timestamp; never render a stale pin as current |
| Payment integration mismatch | Failed checkouts | Payment-link model first; thorough callback testing in test mode |
| Logistics API inconsistency | Broken tracking | Normalise courier states internally; manual override in admin |
| Free-text customer behaviour | Bot confusion | Guided interactive flows plus handover paths |
| Duplicate provider events | Duplicate orders | Idempotency keys plus raw event tracking |
| **Messaging tier cap hit at launch** | Customers unreachable | Model launch volume against the starting tier; monitor quality rating |
| **Tax/GST retrofit after Phase 3** | Expensive rework | Tax modelled from the Phase 1 schema |

---

## 19. MVP Boundary

**Included:** guided browsing · order capture · **location pin capture and geo-validation** · COD · payment link flow · order confirmation · shipment tracking updates · **live rider tracking page** · basic admin dashboard.

**Excluded:** AI recommendations · free-form natural-language shopping · loyalty wallet · automated returns engine (a manual return path is defined in Phase 0 instead) · multi-vendor marketplace · marketing automation · route optimisation across multiple riders · in-chat native payments.

---

## 20. Repository Structure

```text
whatsapp-commerce-bot/
  apps/
    api/            # NestJS backend
    admin/          # Next.js admin panel
    rider/          # Next.js rider PWA
    tracking/       # Public tracking page
    worker/         # BullMQ processors
  packages/
    core/           # Domain logic, state machines, pricing, tax
    integrations/
      whatsapp/     # WhatsAppProvider
      payments/     # PaymentProvider
      logistics/    # LogisticsProvider
      geo/          # GeoProvider
    db/             # Prisma schema, migrations, seeds
    shared/         # Types, validation schemas, utilities
  docs/
    templates/      # WhatsApp template copy and approval status
    runbooks/
  infra/
```

Tooling: pnpm workspaces + Turborepo.

---

## 21. Open Questions for Phase 0

1. BSP or direct Cloud API?
2. Delivery geography as polygons — who supplies the boundaries?
3. Own riders, courier partner, or both? The rider PWA only matters if the client runs their own last mile.
4. Which languages need template translations?
5. COD ceiling and restricted product categories?
6. Return and cancellation policy, and who authorises refunds?
7. Expected daily order volume at launch and at 6 months?
8. Who operates the admin panel day to day, and during what hours?
9. Statutory retention period, confirmed by the client's accountant?
10. Does any product fall under a restricted commerce category?

---

## 22. Final Recommendation

Sell and build this as a **WhatsApp-first commerce platform**, not a chatbot. WhatsApp is the customer interface; the value is in the backend for orders, payments, logistics, and operations.

Two things determine whether this project succeeds:

**First, the compliance track is the critical path, not the code.** Business verification and template approval are external, slow, and capable of rejection. Starting them in week 1 is the difference between a 20-week delivery and an indefinite one.

**Second, be precise about what WhatsApp can and cannot do.** The location layer is the clearest example. Capturing an accurate delivery pin in chat is fully supported and genuinely improves delivery success. Streaming live location inside WhatsApp is not a documented Business Platform capability, so live tracking runs on our own page, linked from an approved template. Designed that way, the feature is real and shippable. Promised the other way, it fails at UAT.

Phased rollout: establish reliable ordering and fulfilment first, then layer better automation, reporting, and optional AI enhancements once real orders are flowing.
