# OmniCommerce AI - Global Ecommerce Automation Platform
## Comprehensive Project Audit & Implementation Blueprint

---

### 1. Product Overview

**OmniCommerce AI** is a commercial, multi-tenant Software-as-a-Service (SaaS) operations platform engineered to automate ecommerce operations globally. It combines:
- **Authoritative Business Logic Engines**: Deterministic order state machines, atomic inventory reservations with concurrency protection, precision-safe financial calculations, and idempotency protection.
- **AI-Assisted Customer & Sales Intelligence**: Grounded in live transactional state using Google Gemini (`gemini-3.8-flash`) with server-side function calling, enforcing strict out-of-stock rules without hallucinating facts.
- **Global Integration Framework**: Modular adapters for payment providers (Stripe, PayPal, COD), shipping carriers (DHL, FedEx, local couriers), and workflow orchestrators (n8n webhooks).
- **Multi-Tenant Administration Console**: Role-based access control (RBAC), multi-currency, and localized tax/shipping configuration.

---

### 2. Key Business Problems & Measurable Objectives

| Problem | Root Cause in Legacy / Manual Setups | OmniCommerce AI Solution | Measurable Metric / KPI |
| :--- | :--- | :--- | :--- |
| **Overselling & Out-of-Stock Discrepancies** | Non-atomic read-then-write stock checks in spreadsheets or disconnected tools | Concurrency-safe atomic reservations with automatic Time-to-Live (TTL) expiration | **Zero** oversold orders; <0.01% inventory variance |
| **Slow Customer Inquiries & Lost Sales** | Manual triage of availability, sizing, and shipping queries | Real-time AI sales assistant with live inventory tool calling | **<3 second** first response time; >70% autonomous resolution rate |
| **Unverified / Duplicate Payments** | Treating client-side redirects or screenshots as proof of payment | Webhook signature verification, server-side transaction reconciliation, and idempotency keys | **100%** verified payment transactions before fulfillment dispatch |
| **Order Processing Bottlenecks** | Human entry of tracking numbers, notifications, and status transitions | Authoritative Order State Machine with automated event webhooks for n8n/carriers | **>85% reduction** in manual fulfillment administrative overhead |
| **Return & Refund Disputes** | Disconnected return requests and unverified item receipts | Two-stage return receipt inspection and authorized refund execution | **100% audit trail** on all financial refunds |

---

### 3. Complete User Journeys: Customer Enquiry to Order Fulfilment

```
[Customer Discovery / Chat]
       │
       ▼
1. Customer asks about availability (e.g. SKU: TSHIRT001)
       │
       ▼
2. AI calls `checkStock(sku)` -> verifies Physical: 24, Reserved: 2 -> Available: 22 units
       │
       ▼
3. Customer adds item to checkout -> System issues atomic `reserveStock()` with 15-min TTL
       │
       ▼
4. Price Engine generates immutable order snapshot (Subtotal + Tax + Shipping - Discounts)
       │
       ▼
5. Order created in state `AWAITING_PAYMENT` with unique Idempotency Key
       │
       ▼
6. Payment processed via Payment Adapter -> Webhook received -> Signature verified -> Idempotency validated
       │
       ▼
7. Order transitions to `CONFIRMED` -> Reservation committed to permanent physical stock deduction
       │
       ▼
8. n8n workflow triggers merchant pack notification & shipping label generation
       │
       ▼
9. Fulfillment Staff scans barcode at packing station -> Status transitions to `READY_FOR_DISPATCH`
       │
       ▼
10. Carrier picks up package with Tracking Reference -> Status transitions to `SHIPPED`
       │
       ▼
11. Carrier delivers package -> Status transitions to `DELIVERED`
```

---

### 4. System Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                        CLIENT / FRONTEND LAYER                         │
│  ┌───────────────────────┐  ┌───────────────────┐  ┌────────────────┐  │
│  │ Merchant Admin Portal │  │ Staff Workspaces  │  │ Storefront &   │  │
│  │ (KPIs, Inventory, RBAC)│  │ (Pack & Support)  │  │ AI OmniBot UI  │  │
│  └───────────┬───────────┘  └─────────┬─────────┘  └───────┬────────┘  │
└──────────────┼────────────────────────┼────────────────────┼───────────┘
               │                        │                    │
               ▼                        ▼                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     API GATEWAY & SECURITY LAYER                       │
│  - Tenant Isolation Middleware (Tenant ID verification & context)      │
│  - Role-Based Access Control (RBAC: Admin, Fulfillment, Support, User) │
│  - Idempotency Middleware (Key deduplication & replay caching)         │
│  - Rate Limiting & Input Validation                                    │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      APPLICATION CORE SERVICES                         │
│  ┌──────────────────────┐  ┌───────────────────┐  ┌────────────────┐  │
│  │ Order State Machine  │  │ Atomic Inventory  │  │ Pricing Engine │  │
│  │ (Deterministic Rules)│  │ (Locks, TTL, TTLs) │  │ (Integer Cents)│  │
│  └───────────┬──────────┘  └─────────┬─────────┘  └───────┬────────┘  │
│              │                        │                    │           │
│  ┌───────────┴──────────┐  ┌─────────┴─────────┐  ┌───────┴────────┐  │
│  │ AI Assistant Engine  │  │ Webhook Engine    │  │ Integration Hub│  │
│  │ (Gemini 3.8 Flash)   │  │ (Sig Verification)│  │ (n8n Adapters) │  │
│  └──────────────────────┘  └───────────────────┘  └────────────────┘  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        DATA PERSISTENCE LAYER                          │
│  - PostgreSQL / Relational Schema (Multi-Tenant schema isolation)      │
│  - Transactions & Row-Level Locking (Atomic Inventory Allocations)     │
│  - Immutable Financial Ledger & Audit Trail                            │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 5. Module-by-Module Feature Specification

- **Module 1: Business and Tenant Management**
  - Tenant registration, slugs, multi-currency defaults (USD, EUR, GBP, KES, etc.), localized tax rates (inclusive vs exclusive).
  - RBAC: `SUPER_ADMIN`, `BUSINESS_OWNER`, `SALES_STAFF`, `FULFILLMENT_STAFF`, `SUPPORT_STAFF`, `CUSTOMER`.
- **Module 2: Product Catalogue**
  - SKU hierarchy, multi-attribute variants (Size, Color, Material), publication status, digital/physical classifications.
- **Module 3: Inventory Management**
  - Formula: $\text{Available} = \max(0, \text{Physical} - (\text{Reserved} + \text{Quarantine}))$.
  - Atomic reservation locks with configurable TTL (default 15 mins).
  - Low-stock threshold alerts and quarantine tracking for damaged returns.
- **Module 4: Order Management**
  - Deterministic state machine with 18 distinct states.
  - Immutable price snapshots captured at checkout.
  - Cancellation rules preventing cancellation of already-dispatched packages.
- **Module 5: Customer Management**
  - Centralized customer records, consent logging, order history, support case threads.
- **Module 6: Payment Management**
  - Provider adapters (Stripe, PayPal, Cash on Delivery).
  - Idempotent webhook receiver with signature validation.
  - Strict separation of authorization, capture, and refund.
- **Module 7: Shipping and Fulfilment**
  - Delivery zones, carrier adapters, parcel tracking reference validation.
- **Module 8: Returns and Refunds**
  - Two-step return workflow: Request -> Physical Warehouse Inspection -> Refund Authorization.
- **Module 9: Notification Management**
  - Event-driven notifications: order placed, payment verified, parcel dispatched, out-of-stock alert.
- **Module 10: Analytics and Operational Reporting**
  - Real-time revenue vs collected payments vs refunds, average order value (AOV), inventory turnover, AI autonomous resolution rate.
- **Module 11: Integration Framework & n8n Automation**
  - Standardized webhook payloads and API schemas for external orchestrators (n8n, Zapier).
- **Module 12: Subscription and Billing Management**
  - SaaS plans (`STARTER`, `GROWTH`, `ENTERPRISE`), usage metering, AI token budget caps.

---

### 6. Complete Order Lifecycle & Allowed State Transitions

```
[DRAFT] ───────► [PENDING_CONFIRMATION] ───────► [AWAITING_PAYMENT]
   │                      │                              │
   │                      ▼                              ▼
   │                 [CANCELLED]                   [PAYMENT_FAILED] ──► [AWAITING_PAYMENT]
   │                                                     │
   └─────────────────────────────────────────────────────┤
                                                         ▼
                                                    [CANCELLED]
                                                         ▲
                                                         │
   [AWAITING_PAYMENT] ──(Payment Verified)──► [CONFIRMED]
                                                  │
                                                  ▼
                                            [PROCESSING]
                                                  │
                                                  ▼
                                         [READY_FOR_DISPATCH]
                                                  │
                                                  ▼
                                              [SHIPPED]
                                                  │
                                                  ▼
                                             [DELIVERED]
                                                  │
                                                  ▼
                                         [RETURN_REQUESTED]
                                                  │
                                                  ▼
                                              [RETURNED]
                                                  │
                                                  ▼
                                          [REFUND_PENDING]
                                                  │
                                                  ▼
                                              [REFUNDED]
```

**Guard Invariants**:
1. No order can transition to `CONFIRMED` unless payment is verified or `paymentMethod === 'CASH_ON_DELIVERY'`.
2. No order can transition to `SHIPPED` without a valid shipping carrier or tracking number.
3. No return can transition to `REFUND_PENDING` without physical warehouse receipt confirmation (`RETURNED`).
4. Terminal states `CANCELLED` and `REFUNDED` cannot transition to active operational states.

---

### 7. Scenario Matrix

| Scenario ID | Category | Trigger Condition | System Behavior & Invariant |
| :--- | :--- | :--- | :--- |
| **SC-INV-A** | Inventory | Stock $\ge$ requested quantity | Reserve quantity, return status `AVAILABLE`, start TTL timer. |
| **SC-INV-B** | Inventory | Stock $== 0$ | Return `OUT_OF_STOCK`, prompt similar products or restock notification. |
| **SC-INV-C** | Inventory | Requested > Available | Return `QUANTITY_EXCEEDED`, suggest available portion. |
| **SC-INV-H** | Inventory | 2 customers request last 1 unit simultaneously | Atomic mutex lock ensures only 1 succeeds; second gets immediate `OUT_OF_STOCK` recovery. |
| **SC-INV-I** | Inventory | Reservation timer exceeds TTL | Automatically release reservation, returning units to Available stock. |
| **SC-PAY-A** | Payment | Webhook `charge.succeeded` | Idempotently verify signature, transition order to `CONFIRMED`, commit stock. |
| **SC-PAY-B** | Payment | Duplicate webhook received | Idempotency store detects processed key, responds 200 OK without double-crediting. |
| **SC-PAY-C** | Payment | Payment fails / declines | Transition to `PAYMENT_FAILED`, retain reservation for grace period (15 min) for retry. |
| **SC-DEL-A** | Delivery | Courier dispatch | Validate tracking ID, transition to `SHIPPED`, fire customer dispatch notification. |
| **SC-DEL-B** | Delivery | Damaged parcel in transit | Transition to `EXCEPTION_REVIEW`, open high-priority customer support case. |

---

### 8. Sample AI Responses for Critical Situations

- **Scenario A (Available)**:
  > "Yes, the Merino Wool Trail Crewneck T-Shirt (SKU: TSHIRT001) is in stock! We have Navy and Charcoal variants available in Medium and Large for $48.00 each. Would you like me to start an order for you?"
- **Scenario B (Completely Out of Stock)**:
  > "I'm sorry, the Vacuum Thermal Trail Flask (SKU: FLASK-VAC-750) is currently out of stock at all our fulfillment centers. I can notify you the moment fresh stock arrives, or recommend our Merino Ribbed Watch Cap. Which would you prefer?"
- **Scenario C (Partial Quantity Available)**:
  > "You requested 10 units of the Ribbed Merino Watch Cap, but we currently have only 2 units available in stock. Would you like to reserve the 2 available units today, or should I connect you with our team regarding an incoming batch?"
- **Scenario D (Sold out during checkout)**:
  > "I apologize, but this item just became unavailable while processing your reservation. Your card has not been charged. Would you like to explore alternative sizes or receive an instant restock alert?"
- **Scenario F (Inventory unreachable)**:
  > "I'm temporarily unable to verify real-time stock levels for that item right now. To guarantee you receive accurate information, would you like me to connect you with our support staff or retry in just a moment?"

---

### 9. Database Schema and Entity Relationships

```sql
-- Multi-Tenant Base
CREATE TABLE tenants (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(128) UNIQUE NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  tax_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  tax_inclusive BOOLEAN NOT NULL DEFAULT false,
  reservation_ttl_minutes INT NOT NULL DEFAULT 15,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Products & Variants
CREATE TABLE products (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(128) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(128),
  base_price_cents INT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  UNIQUE(tenant_id, sku)
);

-- Concurrency-Safe Warehouse Stock
CREATE TABLE warehouse_inventory (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) REFERENCES tenants(id),
  sku VARCHAR(128) NOT NULL,
  warehouse_id VARCHAR(64) NOT NULL,
  physical_stock INT NOT NULL CHECK (physical_stock >= 0),
  reserved_stock INT NOT NULL DEFAULT 0 CHECK (reserved_stock >= 0),
  quarantine_stock INT NOT NULL DEFAULT 0 CHECK (quarantine_stock >= 0),
  low_stock_threshold INT NOT NULL DEFAULT 5,
  version INT NOT NULL DEFAULT 1, -- Optimistic concurrency lock
  UNIQUE(tenant_id, sku, warehouse_id)
);

-- Stock Reservations
CREATE TABLE stock_reservations (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) REFERENCES tenants(id),
  order_id VARCHAR(64) NOT NULL,
  sku VARCHAR(128) NOT NULL,
  warehouse_id VARCHAR(64) NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' -- ACTIVE, COMMITTED, EXPIRED, CANCELLED
);

-- Orders
CREATE TABLE orders (
  id VARCHAR(64) PRIMARY KEY, -- ORD-XXXXXX
  tenant_id VARCHAR(64) REFERENCES tenants(id),
  customer_id VARCHAR(64) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  subtotal_cents INT NOT NULL,
  tax_cents INT NOT NULL,
  shipping_cents INT NOT NULL,
  discount_cents INT NOT NULL DEFAULT 0,
  total_cents INT NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(64) NOT NULL,
  payment_method VARCHAR(64) NOT NULL,
  is_paid BOOLEAN NOT NULL DEFAULT false,
  tracking_number VARCHAR(128),
  shipping_carrier VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency Registry
CREATE TABLE idempotency_records (
  key VARCHAR(255) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  operation VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  response_payload JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, operation, key)
);
```

---

### 10. API Contracts & n8n Workflow Responsibilities

1. **REST APIs (Authoritative Business Operations)**:
   - `POST /api/orders/reserve`: Reserves stock atomically with TTL.
   - `POST /api/orders/create`: Validates items, calculates price, writes order record.
   - `POST /api/orders/transition`: Executes state transition with audit trail.
   - `POST /api/webhooks/payment`: Ingests Stripe/PayPal webhooks idempotently.
   - `GET /api/inventory/status`: Returns physical, reserved, and available counts.

2. **n8n Workflow Responsibilities (Orchestration & External Notification)**:
   - **Order Received Flow**: Listens to `order.confirmed` webhook -> Formats packing slip -> Sends Telegram/WhatsApp alert to fulfillment team.
   - **Low-Stock Alert Flow**: Polled every 30 minutes -> Detects items where `availableStock <= lowStockThreshold` -> Generates vendor reorder draft in Google Sheets / ERP.
   - **Carrier Sync Flow**: Ingests DHL/FedEx status webhook -> Calls OmniCommerce `POST /api/orders/transition` to advance to `SHIPPED` or `DELIVERED`.

---

### 11. Security, Privacy & Tenant Isolation

- **Tenant Isolation**: Every database query and cache key includes `tenantId`. Cross-tenant record queries are rejected by middleware.
- **Idempotency Guard**: Every financial or order mutation accepts `Idempotency-Key` header, preventing duplicate side effects.
- **AI Prompt-Injection Defense**: System prompts explicitly forbid user input from modifying inventory balances or overriding payment status. Tool calling returns structured JSON parameters strictly parsed and validated server-side.
- **No Floating-Point Money**: All financial values are stored and calculated as integer cents.

---

### 12. Phased Implementation Roadmap

- **Phase 1 (Completed Foundation)**:
  - Architecture blueprint, authoritative Order State Machine, atomic inventory engine with concurrency & TTL, precision pricing engine, and 100% passing unit tests.
- **Phase 2 (Current Focus - Foundation Module UI & Simulation)**:
  - Operational multi-role administrative console, real-time atomic inventory management with SKU `TSHIRT001`, live race-condition simulator, order lifecycle inspector, and AI assistant interface.
- **Phase 3**:
  - Full-stack Express backend with server-side Gemini 3.8 Flash tool calling and webhook receiver.
- **Phase 4**:
  - PostgreSQL / Supabase migration with database transaction locks and persistent n8n webhook connectors.
- **Phase 5**:
  - Commercial SaaS billing, subscription tiers, and multi-tenant self-service onboarding.

---

### 13. Test Plan Summary

1. **Unit Tests (16 passed)**: State machine validation, stock reservation concurrency, out-of-stock scenarios, discount vouchers, and tenant-isolated idempotency.
2. **Race-Condition Simulation**: Simulated 2 concurrent shoppers attempting to purchase the last remaining unit of an item.
3. **End-to-End User Journeys**: From natural-language question in AI chat -> SKU availability check -> reservation -> order creation -> payment confirmation -> fulfillment.

---

### 14. Existing Components Audit

- `package.json`: Node 22 runtime, `@google/genai` v2.4.0, Express 4.21, React 19, Lucide React icons, Tailwind CSS v4.
- `metadata.json` & `index.html`: Fully synchronized with platform metadata.
- Historic markers: Preserved test SKU `TSHIRT001` and order `ORD-000008` in active seed dataset.

---

### 15. Next Concrete Implementation Task

Build the rich, responsive **Operational Platform Interface** in React (`src/App.tsx` and modular components) implementing:
1. Executive KPI Overview & Store Switcher.
2. Product & Atomic Inventory Management with Live Stock Adjustments.
3. Interactive Race-Condition Concurrency Simulator.
4. Order Lifecycle State Inspector for `ORD-000008`.
5. AI Customer Service Assistant (OmniBot) with tool invocation transparency.
6. n8n Automation & Webhook Ingestion Simulator.
