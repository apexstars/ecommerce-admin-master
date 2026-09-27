# Meridian — ecommerce admin (modular monolith)

Fastify + Prisma/PostgreSQL + Redis API, and a React + React Query admin UI.

```
apps/api   Fastify, Prisma, Redis, outbox worker      → http://localhost:4000
apps/web   Vite, React 19, React Query, React Router  → http://localhost:5173 (proxies /api)
```

## Quick start

```bash
npm install
cp apps/api/.env.example apps/api/.env
npm run infra:up                    # Postgres 16 + Redis 7 (docker compose)
npm run db:deploy -w apps/api       # apply migrations
npm run db:seed                     # roles, staff, catalog, customers, ~2 weeks of orders
npm run dev                         # API (with in-process outbox worker) + web
```

Sign in at http://localhost:5173 as `admin@shop.test` / `password1234` (Super Admin).
Other seeded staff use the same password: `catalog@`, `fulfillment@`, `support@`, `finance@shop.test`.
`jordan@shop.test` is a pending invite.

`npm test` runs the API unit tests. `npm run typecheck` and `npm run build` cover both apps.

**Product images (optional):** `docker compose --profile storage up -d` starts an S3-compatible
store on :9000. You must create the `S3_BUCKET` bucket (public-read) yourself; any S3-compatible
service works via the `S3_*` variables. Uploads use presigned PUT URLs, so bytes never pass
through the API. Without storage, products show initials placeholders.

**Payments:** with `STRIPE_SECRET_KEY` empty, a built-in fake provider accepts Stripe test tokens:
`pm_card_visa` succeeds and `pm_card_chargeDeclined` fails. Set the key (and
`STRIPE_WEBHOOK_SECRET`) to use Stripe for real.

## Architecture

One deployable, one database, eight modules with hard boundaries:

| Module | Owns | Public API (`src/modules/<m>/index.ts`) |
|---|---|---|
| identity | staff, roles, permissions, customers, admin & customer auth | `installAdminGuard`, `assertCan`, customer lookups |
| audit | `AuditLogEntry` | `recordAudit(tx, …)` |
| catalog | products, variants, categories, images | `getVariants` |
| inventory | `stockQty` writes, reservations, stock ledger | `listLowStock`, event handlers |
| cart | Redis carts (`cart:{owner}` hashes) | `getCartLines`, `clearCart` |
| orders | order lifecycle, checkout, state machine | `lockOrderStatus`, `salesBetween`, … |
| payments | provider integration, `Payment` rows | `createPendingPayment`, `refundForOrder`, … |
| discounts | coupons | `evaluateDiscount`, `redeemDiscount(tx, …)` |
| reports | dashboard aggregation (reads via other modules) | — |

Modules may import each other **only through `index.ts`**; `test/architecture.test.ts`
fails the build otherwise. Each Prisma model is labelled with its owning module in
`schema.prisma`.

### Checkout saga (transactional outbox)

`POST /api/store/checkout` does one thing synchronously. In a single transaction it writes the
order, the pending payment, the discount redemption and an `order.placed` event, then returns
`202`. Everything else runs asynchronously through `OutboxEvent` rows. Each subscriber gets its
own row, retried with exponential backoff and claimed with `FOR UPDATE SKIP LOCKED`, so running
several workers is safe:

```
order.placed ─▶ inventory: atomic reserve ─▶ inventory.reserved ─▶ payments: charge
                      └─▶ inventory.reservation_failed ─▶ orders: cancel ("Out of stock")
payment.succeeded ─▶ orders: mark paid ─▶ order.paid ─▶ inventory: commit reservation
                                                  └─▶ orders: send confirmation
payment.failed ─▶ orders: cancel ─▶ order.cancelled ─▶ inventory: release stock
```

- **Stock never oversells.** Stock is decremented with `UPDATE … WHERE stockQty >= qty`, and
  a CHECK constraint forbids negative stock.
- **Handlers are idempotent.** Every step is a guarded state transition, and provider calls
  use idempotency keys.
- **Races are compensated.** A charge that lands after an admin cancelled the order is refunded
  automatically.

Production runs `npm run worker -w apps/api` separately with `RUN_WORKER_IN_PROCESS=false`.

### Auth & RBAC

- **Separate admin and customer auth.** Admin and customer tokens use different secrets *and*
  audiences, and the API refuses to boot if the two secrets match.
- **Admin sessions.** Access tokens last 15 minutes and are kept in memory only. Sessions live
  in Redis and are revocable, with a rotating refresh token in an httpOnly cookie scoped to
  `/api/admin/auth`. Reusing a refresh token kills the session.
- **2FA.** TOTP enrollment is available at `POST /api/admin/me/2fa/setup` and `/enable`; once
  enabled, login returns a challenge. Failed logins are rate-limited.
- **Fail-closed routes.** Every route under `/api/admin` must declare `config.permission`
  (or `authenticated`/`public`), or the server will not start. Permissions are checked
  before the handler runs.
- **Anti-escalation.** Non-Super-Admins can only grant, revoke or assign permissions they
  hold themselves. Nobody can change their own role. Super Admin is locked, and at least one
  active Super Admin must remain.
- **Audit.** Role changes, permission changes, staff role changes, invites and order
  refunds/cancellations write an `AuditLogEntry` in the *same transaction* as the change.

## Decisions worth knowing

- **`refund` is a fifth action,** valid for `orders` only. The starter roles need
  "orders refund", which view/create/edit/delete can't express. The editor shows `—` for
  combinations that don't exist.
- **Cancelling a *paid* order refunds it,** so it needs `orders:edit` **and** `orders:refund`.
  Fulfillment staff can cancel pending orders only.
- **The dashboard requires `reports:view`, `orders:view` and `inventory:view`,** so it can't
  leak data a role can't otherwise see. Day-over-day deltas compare today so far against
  yesterday up to the same time, in the viewer's time zone.
- **The Orders screen adds a "Refunded" pill** alongside all/pending/paid/fulfilled/cancelled.
  "Paid" means awaiting fulfillment; "Fulfilled" means shipped or delivered.
- **"Deleting" a customer erases them rather than removing the row.** Their name, email,
  login and saved addresses are scrubbed, existing storefront tokens stop working, and the row
  stays so orders and revenue history remain intact. Customer audit entries record *which*
  fields changed, never the values, so the audit log isn't a second copy of personal data.
- **Customer screens show purchase history only with `orders:view`.** Order stats come from the
  orders module (`GET /orders/customer-stats`), so a customers-only role sees contact details
  but not spend.
- **Product stock is the sum across variants.** A per-variant "N variants low or out" hint
  stops a healthy total from hiding a sold-out size.

## Not built yet

- Product create/edit and discount screens. The APIs exist (`/api/admin/products`,
  `/discounts`, `/inventory/.../adjust`); only list screens were in scope.
- Customer-facing storefront UI. The store API (`/api/store/*`) exists for testing the saga.
- 3-D Secure completion on the client. The server marks `requires_action` and the Stripe
  webhook finishes the saga, but no UI drives the challenge.
- Erasing a customer does not scrub the shipping-address snapshot on their past orders. Whether
  that must also be anonymized depends on your legal retention requirements for order records.
- `twoFactorSecret` is stored in plaintext; encrypt it at rest (e.g. KMS) before production.
- Integration tests against a real database. The saga, race and RBAC paths were verified
  manually against the running stack; the automated suite is unit-level.
