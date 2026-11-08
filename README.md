# SokoFlow

Multi-tenant commerce operations for Kenyan retail: a storefront, a deterministic
order state machine, atomic stock reservation, a WhatsApp channel, Safaricom
M-Pesa settlement through Daraja, and a two-stage returns pipeline.

One Express process serves the React SPA and the API. Money, stock and order
state are decided on the server; the browser only ever *asks*.

---

## Quick start

Requires Node >= 22.18. `npm test` passes `--experimental-strip-types` itself
and runs on 22.12, but `npm start` runs `node server.ts` unflagged, and unflagged
TypeScript in Node only arrived in 22.18.

```bash
npm install
cp .env.example .env      # fill in what you have; see Environment below
npm run dev               # http://localhost:3000 — Vite runs in middleware mode
```

That single process serves the UI and `/api/*`. There is no second dev server to
start.

**First sign-in.** Authentication is Firebase Auth. The address you put in
`OWNER_EMAILS` becomes `BUSINESS_OWNER` on first sign-in; everyone else
self-signs-up as `CUSTOMER`. Leave `OWNER_EMAILS` empty in the repository — an
owner address in source is an open door.

---

## What is real, and what is not

Read this before demoing.

| Area | State |
| :--- | :--- |
| Order state machine, pricing, inventory, reservations | Real. Deterministic, unit-tested, server-authoritative. |
| M-Pesa STK push and settlement | Real, when Daraja credentials are set. Without them checkout returns 503 rather than inventing a receipt. |
| Returns (claim → warehouse receipt → inspection → refund) | Real. Stock moves only on inspection; the refund needs an owner's attestation. |
| WhatsApp channel | Real via the Meta Cloud API when configured; otherwise a clearly-labelled simulated mode. |
| Card, Airtel Money, Pesalink | **Not implemented.** They are selectable in checkout, create an order awaiting payment, and charge nothing. |
| KRA eTIMS fiscal receipts | **Not implemented.** Invoices are shop documents built from the persisted order. No fiscal device, no transmission to KRA, no VAT certification. |
| Courier integration | **Not implemented.** No Sendy, Fargo or G4S account and no rider dispatch; carrier and tracking number are typed in at dispatch. |
| AI storefront assistant | **Keyword responses, not a model.** It reads live catalogue and stock, but it is not an LLM. |
| Subscription plans / billing | **Removed.** There is no tier, no metered AI budget and no invoice record. |
| Browser-level UI tests | **None.** The UI is covered by typecheck and build only. |

---

## Scripts

| Script | What it does |
| :--- | :--- |
| `npm run dev` | `tsx server.ts` — API + Vite middleware + HMR-less SPA on port 3000. |
| `npm start` | `node server.ts` — same, without tsx. |
| `npm run build` | `vite build` then `esbuild server.ts` to `server.js`. |
| `npm run preview` | `vite preview` — static `dist` only, no API. |
| `npm run clean` | Deletes `dist` and `server.js`. Cross-platform (node one-liner). |
| `npm run lint` | `tsc --noEmit`. This is the whole static check; there is no separate ESLint config. |
| `npm test` | `node --test` over `src/lib/*.test.ts`. 131 tests; 2 Firestore contract tests skip without an emulator. |
| `npm run test:emulator` | Runs the same suite inside the Firestore emulator, which un-skips those 2. |

---

## Environment

Everything is optional in local development. What each group unlocks:

| Variable | Missing means |
| :--- | :--- |
| `FIREBASE_PROJECT_ID` | Admin SDK falls back to Application Default Credentials; on Cloud Run that is the service identity. |
| `VITE_FIREBASE_*` | The SPA cannot sign in. |
| `OWNER_EMAILS` | Nobody becomes an owner; every new account is a customer. |
| `COMMERCE_STATE_BACKEND` | Defaults to memory. `firestore` is the only safe value outside local dev — memory stock is per-process and oversells across instances. |
| `MPESA_*` | Checkout refuses mobile-money orders with 503 instead of guessing. |
| `MPESA_ALLOW_SIMULATED` | `POST /api/payments/mpesa/simulate` is closed. Ignored when `NODE_ENV=production`. |
| `WHATSAPP_*` | The channel reports unconfigured; sends fail rather than pretend. |
| `CORS_ALLOWED_ORIGINS` | Localhost only outside production. |
| `PORT` | 3000. Cloud Run injects 8080. |

---

## Architecture

```
React 19 SPA (src/components)          src/lib/* engines            Firestore
──────────────────────────────         ────────────────────         ─────────
Storefront / checkout                  orderStateMachine            tenants
Owner workspace / admin overview       pricingEngine                products
Support desk / WhatsApp inbox          inventoryEngine              inventory
Fulfilment workspace                   orderIntake / orderService   orders
Order inspector                        returns                      returns
Returns panel                          idempotency                  counters
                                       permissions                  users
                                       mpesaDaraja / mpesaSettlement whatsapp*
                                       whatsappCloudService
                                    ▲
                                    │  Express (server.ts), 41 routes
                                    ▼
                              bearer token → requireRoles → tenant scope
```

`server.ts` owns the trust boundary:

1. Firebase ID token verified by the Admin SDK (`requireAuth`).
2. Role checked per route (`requireRoles`).
3. Every read and write is scoped to `req.authUser.tenantId`; the client never
   names a tenant.
4. Domain errors map to status codes: unknown tenant → 404, invalid tenant field
   → 400 with `field`, commerce state unavailable → 503.

`firestore.rules` denies all client access. The SPA has no database credential;
it talks to the API.

---

## The guarantees the code actually enforces

1. **No overselling.** Availability is `max(0, physical − (reserved + quarantine))`,
   and reservation runs inside a Firestore transaction. Two shoppers racing for
   the last unit: one wins, the other is told.
2. **No payment claim from the browser.** The client states SKUs and quantities;
   the server prices from the catalogue. `isPaid` only becomes true from a
   Daraja callback or a staff attestation on a non-mobile-money rail.
3. **No unbacked refund.** `POST /api/returns/:id/refund` requires a refund
   reference from an owner. It records that money moved; it does not move it.
4. **Nothing restocks on a promise.** A return books goods into quarantine on
   receipt and only returns them to the shelf at inspection, after a human grades
   them. Rejected goods stay out.
5. **Tenant isolation.** Every query filters on `tenantId`; a lookup for another
   tenant's order returns 404, not a permission error.
6. **No floating-point money.** All amounts are integer cents, KES included.

---

## API surface

All routes are under `/api` and require a bearer token except `/health` and the
M-Pesa callback.

| Group | Routes |
| :--- | :--- |
| Health | `GET /health` |
| Tenants | `GET /api/tenant`, `PATCH /api/tenant`, `GET/POST /api/tenants` |
| Users | `GET/POST /api/users`, `PUT /api/users/:id/role` |
| Orders | `GET/POST /api/orders`, `PUT /api/orders/:id`, `POST /api/orders/:id/payment` |
| M-Pesa | `POST /api/orders/:id/mpesa/stk-push`, `POST /api/payments/mpesa/callback`, `GET /api/payments/mpesa/:checkoutRequestId/status`, `POST /api/payments/mpesa/simulate` |
| Returns | `GET/POST /api/returns`, `GET /api/returns/:id`, `POST /api/returns/:id/{receive,inspect,refund}` |
| Inventory | `GET /api/inventory`, `POST /api/inventory/{adjust,reserve,sweep}`, `POST /api/inventory/reservations/:id/{commit,cancel}` |
| Catalogue | `GET/POST /api/products` |
| WhatsApp | `POST /api/whatsapp/{config,send,messages,reset,verify-code,request-code,register}`, `GET /api/whatsapp/{messages,logs,status}`, `GET/POST /api/web-chat` |

`GET /api/orders` is scoped for `CUSTOMER`: you see your own orders or, with a
staff role, the tenant's.

### Roles

`SUPER_ADMIN`, `BUSINESS_OWNER`, `SALES_STAFF`, `FULFILLMENT_STAFF`,
`SUPPORT_STAFF`, `CUSTOMER`.

Returns split by role: any authenticated user may raise a claim on a delivered
order they can see; receiving and grading needs owner, super admin or
fulfilment; releasing the refund is owner or super admin only. UI gating in
`ReturnsPanel` mirrors the server, and the server is still the authority.

---

## Testing

```bash
npm test                 # unit + contract, no network
npm run test:emulator    # same, with the 2 Firestore contract tests enabled
```

The suite is deliberately arithmetic-heavy: the inventory, pricing, returns and
idempotency tests assert counts and cents before and after each operation, so a
refactor that quietly restocks on a promise fails there.

There is no DOM test harness. UI changes are verified by `npm run lint` and
`npm run build` only; treat manual checking as required for anything visual.

---

## Deployment

```bash
docker build -t sokoflow \
  --build-arg VITE_FIREBASE_API_KEY=... \
  --build-arg VITE_FIREBASE_AUTH_DOMAIN=... \
  --build-arg VITE_FIREBASE_PROJECT_ID=... \
  --build-arg VITE_FIREBASE_APP_ID=... .
docker run -p 8080:8080 -e PORT=8080 --env-file .env sokoflow
```

Those four are build args rather than something read from `.env` because
`.dockerignore` keeps `.env` out of the build context, and Vite inlines `VITE_*`
at build time. They are public identifiers; the secrets are runtime variables and
stay out of the image entirely.

The image builds `dist` and bundles `server.js`, then runs with
`NODE_ENV=production`, which switches Vite middleware off and serves `dist`
statically. `MPESA_CALLBACK_URL` must be the public URL ending in
`/api/payments/mpesa/callback`. See [docs/WHATSAPP_WEBHOOK_HOSTING.md](docs/WHATSAPP_WEBHOOK_HOSTING.md)
for the WhatsApp side.

Two things the container needs that the repository cannot supply:

- **Firestore credentials.** Without them the admin SDK falls back to Application
  Default Credentials; on Cloud Run that is the service identity, and nowhere else
  it is nothing. Orders and returns fail closed (503) rather than queueing in
  memory, so a missing credential is visible immediately instead of losing sales.
- **A Firebase project.** There is no `.firebaserc` in the repository on purpose:
  the target project is a deployment decision, not a source file. Run
  `firebase use --add` once, or set `FIREBASE_PROJECT_ID` in the environment. A
  committed `.firebaserc` would point every clone at one project and make
  `firebase deploy` fail with a confusing error on any other.

`index.html` carries an inline HMR shim for the preview environment. The build
strips it (see `stripDevHmrShim` in `vite.config.ts`), so a production page keeps
its real `window.WebSocket` and its real console errors.

CI (`.github/workflows/ci.yml`) runs install → typecheck → tests → build on every
push and pull request. It needs no secrets.

### One push deploys both halves

`.github/workflows/deploy.yml` runs on every push to `main`. A push is the whole
release procedure:

1. **verify** — the same typecheck, tests and build as CI. A commit that fails
them never reaches the deploy job.
2. **build** — `cloudbuild.yaml` builds the image and pushes it to Artifact
   Registry, tagged with the commit SHA.
3. **deploy** — `gcloud run deploy` rolls the service to that tag.
4. **rules** — `firebase deploy --only firestore:rules,firestore:indexes`.
5. **smoke test** — runs `tools/smoke-deployed.mjs` against the deployed URL. It
   asserts `/health` reports a durable commerce backend, that the served bundle
   carries the Firebase project id, and that no dev HMR shim survived into
   `index.html`. The run **fails** on any of them. A green deploy that is still
   answering from the previous build has happened here before; this step makes
   that impossible to miss. The same script runs locally:
   `node tools/smoke-deployed.mjs https://<service-url>`.

One Cloud Run service serves both the API and the built SPA (`server.ts` serves
`dist` when `NODE_ENV=production`), so there is one origin and no CORS or
`VITE_API_BASE_URL` to keep in sync.

#### One-time setup

CI authenticates keylessly through **Workload Identity Federation**: pool
`github`, provider `omniapp`, which only accepts OIDC tokens for
`nyakegojohn36-dot/omniapp`, and grants that repository
`roles/iam.workloadIdentityUser` on the deployer. No repository secret is needed.

Repository **variables** (public values, so not secrets):

| Name | Value |
| --- | --- |
| `VITE_FIREBASE_API_KEY` | from the web app config |
| `VITE_FIREBASE_AUTH_DOMAIN` | `sokoflow-whatsapp.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | `sokoflow-whatsapp` |
| `VITE_FIREBASE_APP_ID` | from the web app config |
| `OWNER_EMAILS` | the address that signs in as `BUSINESS_OWNER` |

The deployer service account needs:

```
roles/run.admin                roles/cloudbuild.admin
roles/iam.serviceAccountUser   roles/artifactregistry.admin
roles/storage.admin            roles/firebaserules.admin
roles/datastore.indexAdmin     roles/serviceusage.serviceUsageViewer
```

`artifactregistry.admin` rather than `writer`: the first deploy creates the
repository, and `writer` only covers pushing to one that already exists.

The **Cloud Build service account**
(`<project-number>@cloudbuild.gserviceaccount.com`) also needs
`roles/artifactregistry.writer`, because the build itself is what pushes the
image. Without it the build succeeds and the push fails with `denied`.

Enable these APIs on the project: Cloud Run, Cloud Build, Artifact Registry,
Firestore, Identity Toolkit, IAM Credentials, Security Token Service and Secret
Manager.

#### Runtime configuration

The workflow sets only `NODE_ENV`, `FIREBASE_PROJECT_ID`,
`COMMERCE_STATE_BACKEND`, `SEED_REFERENCE_CATALOGUE=false` (production starts with
an empty catalogue, not demo stock) and `OWNER_EMAILS`, using `--update-env-vars`
so anything else already on the service survives. The WhatsApp access token, app
secret and verify token, and the Daraja keys, live in Secret Manager and are
mounted on the Cloud Run service once (`--update-secrets`). They are not in the
workflow and not in the image.

The service gets a `*.run.app` URL. `sokoflow.ai.studio` belongs to AI Studio's
hosting, so pointing that domain at this service means adding a domain mapping in
Cloud Run — otherwise the two continue to be separate deployments.

---

## Layout

```
server.ts              Express app: auth, RBAC, all routes, Vite/static mount
src/lib/               Domain engines + their tests (the interesting code)
src/components/        React views, one per workspace
src/App.tsx            Session, role, tab routing, order state
docs/                  Architecture blueprint, WhatsApp hosting notes
firestore.rules        Deny-all for clients; the API is the only door
```
