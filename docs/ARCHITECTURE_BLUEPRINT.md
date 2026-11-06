# SokoFlow — Architecture

This document describes the system as it is built, not as it was once planned.
Where something is a stub, a simulation, or absent, it says so. A blueprint that
claims a PostgreSQL ledger the code does not have is worse than no blueprint.

---

## 1. Shape of the system

One Node process. Express serves the API and, in development, mounts Vite in
middleware mode; in production it serves the built `dist` folder. Firestore is
the only durable store.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Browser — React 19 SPA (src/components)                              │
│  storefront · owner workspace · admin overview · support desk        │
│  fulfilment · order inspector · returns panel · WhatsApp channel     │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ fetch + Bearer <Firebase ID token>
┌───────────────────────────────▼──────────────────────────────────────┐
│ server.ts — 41 routes                                                │
│  requireAuth → requireRoles → tenant scope → domain engine → Firestore│
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│ src/lib — domain engines, framework-free and unit-tested             │
│  orderStateMachine  pricingEngine   inventoryEngine                  │
│  orderIntake        orderService    returns                          │
│  idempotency        permissions     mpesaDaraja / mpesaSettlement    │
│  commerceState (memory) / firestoreCommerceState (Firestore)         │
│  tenantRepository   userStore       whatsappCloudService             │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                       Firestore (firebase-admin)
```

The SPA holds no database credential. `firestore.rules` denies all direct
client access, so the only door is the API.

---

## 2. Trust boundary

Four rules, applied in this order on every request:

1. **`requireAuth`** verifies the Firebase ID token with the Admin SDK and
   attaches `req.authUser = { id, tenantId, role, email }`.
2. **`requireRoles(...)`** rejects a role that is not on the route's list, before
   any data is read.
3. **Tenant scope.** The client never names a tenant. `req.authUser.tenantId` is
   the only tenant identifier used, and every query filters on it. Asking for
   another tenant's order returns 404, not a forbidden error — the record does
   not exist as far as that caller is concerned.
4. **Server-side derivation.** Prices, tax, warehouse selection, refund amount,
   and `isPaid` are computed from persisted state. A request body may say *what*
   to buy; it may not say *how much* it costs or whether it is paid.

Error mapping is fail-closed: `UnknownTenantError` → 404,
`TenantValidationError` → 400 with the offending `field`,
`CommerceStateUnavailableError` → 503. A route whose backing store is missing
refuses; it does not degrade into an in-memory answer.

---

## 3. Domain modules

| Module | File | Responsibility |
| :--- | :--- | :--- |
| Order state machine | `orderStateMachine.ts` | `ALLOWED_TRANSITIONS` table plus guards; appends an audit entry on every move. |
| Pricing | `pricingEngine.ts` | Integer-cent subtotal, discount, shipping, tax, total. Tax direction comes from `tenant.taxInclusive`. |
| Inventory | `inventoryEngine.ts` | `available = max(0, physical − (reserved + quarantine))`; reserve, commit, release, adjust. |
| Commerce state | `commerceState.ts`, `firestoreCommerceState.ts` | The storage contract. `firestore` runs reservations inside `runTransaction`; `memory` is a single-process dev fallback. |
| Order intake | `orderIntake.ts` | Validates the basket against the catalogue, prices it, reserves stock, builds the order. |
| Order service | `orderService.ts` | Reservation reconciliation when an order is confirmed or cancelled. |
| Returns | `returns.ts` | Claim → warehouse receipt → inspection → refund attestation, with quarantine arithmetic. |
| Idempotency | `idempotency.ts` | Key deduplication for replay-prone operations. |
| Permissions | `permissions.ts` | Tab-level RBAC per role for the UI. |
| Tenants | `tenantRepository.ts` | Tenants are Firestore documents, not constants; seeding is idempotent. |
| Users | `userStore.ts`, `firebaseAdmin.ts` | Role assignment, owner allowlist, order/return id sequencing. |
| M-Pesa | `mpesaDaraja.ts`, `mpesaSettlement.ts` | STK push, callback parsing, settlement against the order. |
| WhatsApp | `whatsappCloudService.ts`, `whatsappAdapter.ts` | Meta Cloud API transport, inbound routing, session state, simulated mode. |

The engines import nothing from React or Express. That is why they can be tested
with `node --test` and no mocks of the hosting framework.

---

## 4. Data model (Firestore)

| Collection | Document id | Holds |
| :--- | :--- | :--- |
| `tenants` | `<tenantId>` | Currency, locale, timezone, tax rate and direction, reservation TTL, channels. |
| `users` | Firebase uid | Profile plus `tenantId` and `role`. |
| `products` | `<tenantId>:<sku>` | Catalogue entry with variants. |
| `inventory` | `<tenantId>:<sku>:<warehouseId>` | `physicalStock`, `reservedStock`, `quarantineStock`, `lowStockThreshold`. |
| `inventoryReservations` | reservation id | Quantity, warehouse, `expiresAt`, status. |
| `inventoryAdjustments` | adjustment id | Every manual stock change, for audit. |
| `orders` | `<tenantId>:<orderId>` | The order document the state machine owns. |
| `returns` | `<tenantId>:<returnId>` | Claim lines, status, `refundCents`, audit trail. |
| `counters` | `<tenantId>:orderSequence`, `<tenantId>:returnSequence` | Monotonic numbering, allocated in a transaction so an id is never reused. |
| `whatsappMessages` | `<tenantId>:<messageId>` | Inbound and outbound message log. |
| `whatsappSessions` | `<tenantId>:<phone>` | Conversation state per customer phone. |
| `whatsappProcessedMessages` | provider message id | Webhook replay guard. |

Document ids are prefixed with the tenant. That makes cross-tenant id collision
structurally impossible rather than a rule someone has to remember.

Order numbers and return numbers come from `counters` inside a `runTransaction`.
A duplicate number would let two claims collide on one refund, so there is no
in-memory fallback for that sequence.

---

## 5. Order lifecycle

```
DRAFT ─► PENDING_CONFIRMATION ─► AWAITING_PAYMENT ─► CONFIRMED ─► PROCESSING
             │                        │                 │            │
             │                        ▼                 ▼            ▼
             │                   PAYMENT_FAILED    ON_HOLD   READY_FOR_DISPATCH
             │                        │                 │            │
             ▼                        ▼                 ▼            ▼
         CANCELLED ◄──────────────────┴─────────── CANCELLATION_REQUESTED
                                                                    │
                                          SHIPPED ◄─ PARTIALLY_FULFILLED
                                             │
                                             ▼
                                         DELIVERED ─► RETURN_REQUESTED
                                                             │
                                                             ▼
                                                         RETURNED ─► REFUND_PENDING
                                                                        │
                                                                        ▼
                                                             PARTIALLY_REFUNDED / REFUNDED
```

`EXCEPTION_REVIEW` hangs off `AWAITING_PAYMENT`, `PROCESSING`,
`READY_FOR_DISPATCH`, `PARTIALLY_FULFILLED`, `SHIPPED`, `RETURN_REQUESTED`,
`RETURNED`, `REFUND_PENDING` and `ON_HOLD`. Short payments, damaged parcels and
mismatched goods are human decisions; the machine parks them rather than guessing.

Terminal states: `CANCELLED`, `REFUNDED`.

### Guards

1. **CONFIRMED requires money.** A prepaid order cannot enter `CONFIRMED` unless
   `isPaid` is true or the caller passed `paymentConfirmed` — and the only route
   that passes that flag is `POST /api/orders/:id/payment`, which refuses M-Pesa
   orders outright, because those must settle through the Daraja callback.
2. **SHIPPED requires a courier.** Either a carrier or a tracking reference must
   exist on the order or in the transition context.
3. **RETURNED requires the box.** The return must be physically received before
   the order may be marked `RETURNED`.
4. **Terminal means terminal.** No transition out of `CANCELLED` or `REFUNDED`.

Every transition appends `{ id, timestamp, fromStatus, toStatus, actor,
actorRole, reason }` to `order.auditTrail`. Address corrections made through
`PUT /api/orders/:id` append an entry too, with `fromStatus === toStatus`.

---

## 6. Returns and money

A return is four separate events, and only the third moves stock:

| Stage | Endpoint | Stock effect |
| :--- | :--- | :--- |
| Claim | `POST /api/returns` | None. Order → `RETURN_REQUESTED`. Goods are still with the customer. |
| Receipt | `POST /api/returns/:id/receive` | Quarantine +q (physical +q). Counted, unsellable. |
| Inspection | `POST /api/returns/:id/inspect` | Approve: restock r from quarantine, scrap d from physical and quarantine, order → `REFUND_PENDING`. Reject: reverse the receipt, order → `DELIVERED`. |
| Refund | `POST /api/returns/:id/refund` | **None.** Records that money moved, against a `refundReference`. |

The last stage is deliberately an attestation, not an execution. `markRefundPaid`
requires a non-empty reference from an owner or super admin, and it sets the
order to `REFUNDED`. It does not call Daraja, a bank or a card processor —
reversing an M-Pesa payment is a separate B2C integration that does not exist
yet. Anyone who needs the money to actually move does it out of band and then
records the reference here.

---

## 7. Failure modes that were designed for

| Situation | Behaviour |
| :--- | :--- |
| Two shoppers, one unit | Reservation runs in a Firestore transaction. One wins; the loser gets `OUT_OF_STOCK` with the available count. |
| Abandoned checkout | `startReservationSweeper` releases reservations past `expiresAt`, returning units to available. |
| Duplicate M-Pesa callback | The callback is always answered 200 so Daraja stops retrying, and the settlement path returns `ALREADY_SETTLED` for an order that is already paid. A retry changes nothing. WhatsApp webhooks use a separate `whatsappProcessedMessages` guard. |
| Payment arrives for a cancelled order | The `CONFIRMED` transition is refused. The settlement path then tries `EXCEPTION_REVIEW` and returns `REQUIRES_REVIEW`; if that is unreachable from the current state, the order is left alone and the callback is logged. Money is never applied to an order the machine refuses. |
| Collected less than requested | `mpesaSettlement` compares against `mpesaAmountKes`. A short payment parks the order in `EXCEPTION_REVIEW` instead of confirming it. |
| Tenant record missing | Routes answer 404 through `UnknownTenantError`. There is no silent fallback to a default tenant. |
| Firestore unavailable | Reads/writes that must be durable throw `CommerceStateUnavailableError` → 503. Nothing is silently answered from memory for money or stock. |
| Daraja not configured | STK push answers 503. There is no simulated receipt outside explicit local opt-in. |

---

## 8. Roles

| Role | Sees | Can |
| :--- | :--- | :--- |
| `SUPER_ADMIN` | Everything, all tenants | Create tenants, assign roles, everything an owner can do. |
| `BUSINESS_OWNER` | All tenant tabs | Adjust stock, transition orders, manage integrations, receive/inspect returns, release refunds. |
| `SALES_STAFF` | Storefront, inventory, orders, AI sales | Place orders on a customer's behalf. No stock adjust, no refund. |
| `FULFILLMENT_STAFF` | Overview, inventory, orders | Adjust stock, move orders to dispatch/shipped, receive and grade returns. No refund release. |
| `SUPPORT_STAFF` | Support, WhatsApp, orders, storefront | Reply, correct a delivery address before dispatch, raise returns. No refund release, no stock adjust. |
| `CUSTOMER` | Storefront, own orders | Buy, view own orders, claim a return on a delivered order. |

UI gating in `permissions.ts` and `ReturnsPanel` mirrors the server, but the
server re-checks. The UI is a courtesy; it is not the control.

---

## 9. Payment rails, truthfully

| Rail | What actually happens |
| :--- | :--- |
| `MPESA_EXPRESS`, `MPESA_PAYBILL` | Server asks Daraja for an STK push, stores `checkoutRequestId`, and waits. `isPaid` and `mpesaReceiptCode` are written only by the authenticated callback. Money and order are compared; a mismatch parks the order in `EXCEPTION_REVIEW`. |
| `CASH_ON_DELIVERY` | Order may reach `CONFIRMED` without payment, by design. Staff record the reference through `POST /api/orders/:id/payment`, which is the attestation path. |
| `BANK_TRANSFER` | Order waits as unpaid. Staff attest with a reference once the money is seen. |
| `CREDIT_CARD`, `AIRTEL_MONEY`, `DIGITAL_WALLET` | **Not integrated.** Selecting one creates an unpaid order and charges nothing. The UI says so. |

---

## 10. Deliberately absent

Listing these keeps the next reader from assuming they exist:

- **No subscription billing, plans or AI budget metering.** Removed; a tenant is
  described only by things the code enforces.
- **No KRA eTIMS integration.** The invoice modal renders a shop invoice from the
  persisted order and states that it is not a fiscal receipt.
- **No card acquiring, no Pesalink, no Airtel Money settlement.**
- **No LLM.** The storefront assistant is keyword matching over the live
  catalogue. `@google/genai` is not wired to anything.
- **No carrier integration.** Tracking numbers and carriers are free text typed
  by staff; there is no label generation or status webhook from a courier.
- **No automated refund execution.** See §6.
- **No browser-level test harness.** The UI is covered by `tsc --noEmit` and a
  production build only. Manual review is required for visual changes.
- **No migrations tool.** Firestore is schemaless; validation lives in
  `normalizeTenant` and the intake/order engines.

---

## 11. Testing

`npm test` runs `node --test` over `src/lib/*.test.ts`: 128 tests, 2 of which are
Firestore contract tests that skip unless `npm run test:emulator` supplies an
emulator.

The suites are arithmetic-first on purpose. Inventory, pricing, returns and
idempotency tests assert exact counts and cents before and after each operation,
so a refactor that restocks on a promise, or rounds a shilling away, fails there
rather than in production.

CI (`.github/workflows/ci.yml`) runs install → typecheck → tests → build with no
secrets, because nothing in that path needs the network.
