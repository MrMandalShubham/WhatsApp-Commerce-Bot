# Deploying to Railway + Supabase

Five services, one database, one Redis. All images build from the Dockerfiles
already in the repo using the `prod` target.

---

## 1. Supabase (done)

Project `whatsapp-commerce-prod`, region **ap-south-1 (Mumbai)**, PostGIS 3.3
enabled, 31 tables migrated.

**Use the pooler, never `db.<ref>.supabase.co`.** That host is IPv6-only and
Railway containers cannot reach it — the same reason it failed from Docker
locally.

| Variable | Value |
|---|---|
| `DATABASE_URL` | `…@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1` |
| `DIRECT_URL` | `…@aws-0-ap-south-1.pooler.supabase.com:5432/postgres` |

`pgbouncer=true` is required: transaction pooling cannot hold prepared
statements, and Prisma has to be told to stop using them.

---

## 2. Railway services

Create one project with **six** services — five apps plus Redis.

| Service | Dockerfile | Target | Public? |
|---|---|---|---|
| `api` | `apps/api/Dockerfile` | `prod` | yes |
| `worker` | `apps/worker/Dockerfile` | `prod` | no |
| `admin` | `apps/admin/Dockerfile` | `prod` | yes |
| `rider` | `apps/rider/Dockerfile` | `prod` | yes |
| `tracking` | `apps/tracking/Dockerfile` | `prod` | yes |
| `redis` | Railway Redis plugin | — | no |

Set **root directory to the repository root** for every service — the
Dockerfiles copy the whole workspace because the apps share `packages/`.

### Ports

Nothing to configure. The API reads `PORT`, and Next's standalone server reads
`PORT` and `HOSTNAME` — both verified against a container started with
`PORT=7777`.

---

## 3. Environment variables

### `api` and `worker`

```
NODE_ENV=production
DATABASE_URL=<supabase pooler, 6543, ?pgbouncer=true&connection_limit=1>
DIRECT_URL=<supabase pooler, 5432>
REDIS_URL=${{Redis.REDIS_URL}}

JWT_SECRET=<openssl rand -hex 32>
TRACKING_TOKEN_SECRET=<openssl rand -hex 32>

WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<invent one, paste the same value into Meta>
WHATSAPP_API_VERSION=v21.0

RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

API_PUBLIC_URL=https://<api>.up.railway.app
TRACKING_PUBLIC_URL=https://<tracking>.up.railway.app/track
SHOP_NAME=<the shop's name, shown in the greeting>
DEFAULT_CURRENCY=INR
```

The API **refuses to boot in production** without the WhatsApp and Razorpay
secrets — deliberate, so a half-configured deploy fails immediately rather
than silently dropping messages.

### `admin`, `rider`, `tracking`

```
NEXT_PUBLIC_API_URL=https://<api>.up.railway.app
```

⚠️ This one is compiled into the client bundle **at build time**, not read at
runtime. Railway exposes service variables as build args, and the Dockerfiles
declare `ARG NEXT_PUBLIC_API_URL` to pick it up — but it means **changing this
value requires a rebuild, not just a restart.**

---

## 4. Migrations

Run once against Supabase, from the repo:

```bash
pnpm --filter @wcb/db exec prisma migrate deploy
```

Or set it as the API service's Railway **pre-deploy command** so every deploy
applies pending migrations before the new version starts:

```
pnpm --filter @wcb/db exec prisma migrate deploy
```

Never `prisma db push` against production — it drops what it does not
recognise.

---

## 5. After the first deploy

1. **Health check** — `GET https://<api>.up.railway.app/health/ready` should
   return `{"status":"ok","db":true,"redis":true,"postgis":true}`. If
   `postgis` is false, the extension is not enabled on the database.

2. **Seed the owner account**

   ```bash
   SEED_ADMIN_EMAIL=you@shop.com SEED_ADMIN_PASSWORD='<20+ chars>' \
     pnpm --filter @wcb/db exec tsx prisma/seed-production.ts
   ```

3. **Point Meta at the webhook**
   - Callback URL: `https://<api>.up.railway.app/webhooks/whatsapp`
   - Verify token: the `WHATSAPP_WEBHOOK_VERIFY_TOKEN` you set
   - Subscribe to the `messages` field

4. **Point Razorpay at the webhook**
   - `https://<api>.up.railway.app/webhooks/payment`
   - Events: `payment_link.paid`, `payment_link.expired`, `payment.failed`

5. **Draw the service area** in the admin panel. Until one exists nothing is
   deliverable and every order goes to a human.

6. **Add products and at least one rider.**

7. **Mark templates approved** as Meta clears each one. The send path refuses
   anything not `APPROVED`, so notifications stay silent until then.

---

## Still open before real customers

- **Map tiles are OpenStreetMap**, which is not licensed for production
  traffic. Swap the tile URL in `apps/tracking/src/components/Map.tsx` and
  `apps/admin/src/components/AreaMap.tsx` for a paid provider.
- **No password-change screen.** The seeded password is the only way in.
- **No product image upload** — needs Supabase Storage wiring.
- **`findNearbyAddress`** (25 m address dedup) is written and tested but not
  yet called from the checkout flow.
- **Rider creation has no UI** — a rider needs a `staff_users` row with role
  `RIDER` plus a linked `riders` row.

## Rollback

Railway keeps previous deploys; redeploy an earlier build to roll back the
app. **Database migrations do not roll back** — a migration that drops a
column is not reversible by redeploying. Take a Supabase backup before any
migration that removes or renames anything.
