/**
 * Order Intake - the server-side authoritative checkout.
 *
 * The browser used to build a complete Order (prices, totals, status, payment
 * flag) and POST it verbatim. That meant stock could be fabricated and money
 * could be invented. This module rebuilds the order from primitives the client
 * is allowed to choose (what to buy, where to ship, how to pay) and derives
 * everything else from the catalogue, the tenant's tax configuration, and the
 * store's atomic reservation.
 *
 * Invariants:
 *   1. Unit prices and totals come from the catalogue, never from the request.
 *   2. Stock is reserved atomically; a partial failure rolls back every line.
 *   3. A prepaid order is never created as paid. It starts in AWAITING_PAYMENT
 *      and only a verified payment event may confirm it (see orderStateMachine).
 *   4. Client-supplied totals are recorded as a discrepancy warning, not used.
 */

import { calculateOrderPricing } from './pricingEngine.ts';
import { generateOrderId, validateOrderAddress } from './orderService.ts';
import type { CommerceState } from './commerceState.ts';
import type {
  Order,
  OrderAddress,
  OrderItem,
  PaymentMethod,
  Product,
  Tenant,
} from './types.ts';

export interface OrderIntakeLine {
  sku: string;
  quantity: number;
}

export interface OrderIntakeRequest {
  items: OrderIntakeLine[];
  customer: {
    id?: string;
    name: string;
    email: string;
    phone?: string;
  };
  shippingAddress: OrderAddress;
  paymentMethod: PaymentMethod;
  discountCode?: string;
  mpesaPhoneNumber?: string;
  notes?: string;
  /** Client's own arithmetic. Compared, never trusted. */
  claimedTotalCents?: number;
}

export interface OrderIntakeDeps {
  tenant: Tenant;
  state: CommerceState;
  products: Product[];
  /** Server-owned sequence; must be monotonic per tenant. */
  nextOrderId: () => Promise<number>;
}

export type OrderIntakeFailureStatus = 400 | 409 | 422;

export type OrderIntakeResult =
  | { ok: true; order: Order; reservationIds: string[]; warnings: string[] }
  | {
      ok: false;
      status: OrderIntakeFailureStatus;
      error: string;
      sku?: string;
      availableStock?: number;
    };

const MAX_LINES = 50;
const MAX_QUANTITY_PER_LINE = 1000;

/** A sellable SKU is either the product itself or one of its variants. */
interface CatalogueEntry {
  product: Product;
  unitPriceCents: number;
  variantName?: string;
}

/**
 * Indexes the catalogue by every SKU a shopper can actually name. Variants are
 * separate sellable units with their own stock rows, so a variant SKU must
 * resolve to its parent product rather than be rejected as unknown.
 */
function indexCatalogue(products: Product[]): Map<string, CatalogueEntry> {
  const index = new Map<string, CatalogueEntry>();
  for (const product of products) {
    index.set(product.sku.toUpperCase(), {
      product,
      unitPriceCents: product.basePriceCents,
    });
    for (const variant of product.variants || []) {
      if (!variant?.sku) continue;
      index.set(variant.sku.toUpperCase(), {
        product,
        unitPriceCents: variant.priceCents || product.basePriceCents,
        variantName: variant.name,
      });
    }
  }
  return index;
}

const VALID_PAYMENT_METHODS: PaymentMethod[] = [
  'MPESA_EXPRESS',
  'MPESA_PAYBILL',
  'AIRTEL_MONEY',
  'CREDIT_CARD',
  'BANK_TRANSFER',
  'CASH_ON_DELIVERY',
  'DIGITAL_WALLET',
];

function fail(
  status: OrderIntakeFailureStatus,
  error: string,
  extra?: { sku?: string; availableStock?: number }
): OrderIntakeResult {
  return { ok: false, status, error, ...extra };
}

/** Rejects malformed lines before any stock is touched. */
function normalizeLines(lines: OrderIntakeLine[]): OrderIntakeResult | OrderIntakeLine[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    return fail(400, 'An order must contain at least one item.');
  }
  if (lines.length > MAX_LINES) {
    return fail(400, `An order may contain at most ${MAX_LINES} distinct items.`);
  }

  const merged = new Map<string, number>();
  for (const line of lines) {
    const sku = typeof line?.sku === 'string' ? line.sku.trim().toUpperCase() : '';
    const quantity = Number(line?.quantity);

    if (!sku) return fail(400, 'Every order line requires a SKU.');
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return fail(400, `Quantity for ${sku} must be a positive whole number.`);
    }
    if (quantity > MAX_QUANTITY_PER_LINE) {
      return fail(400, `Quantity for ${sku} exceeds the ${MAX_QUANTITY_PER_LINE} unit limit per line.`);
    }
    merged.set(sku, (merged.get(sku) || 0) + quantity);
  }

  return Array.from(merged.entries()).map(([sku, quantity]) => ({ sku, quantity }));
}

function isLineList(value: OrderIntakeResult | OrderIntakeLine[]): value is OrderIntakeLine[] {
  return Array.isArray(value);
}

export async function createOrderFromIntake(
  request: OrderIntakeRequest,
  deps: OrderIntakeDeps
): Promise<OrderIntakeResult> {
  const { tenant, state, products } = deps;

  if (!request.customer?.name?.trim()) {
    return fail(400, 'Customer name is required.');
  }
  if (!request.customer?.email?.includes('@')) {
    return fail(400, 'A valid customer email is required.');
  }
  const addressValidation = validateOrderAddress(request.shippingAddress);
  if (!addressValidation.valid) {
    return fail(400, addressValidation.error || 'A valid shipping address is required.');
  }
  if (!VALID_PAYMENT_METHODS.includes(request.paymentMethod)) {
    return fail(400, 'Unsupported payment method.');
  }

  const normalized = normalizeLines(request.items);
  if (!isLineList(normalized)) return normalized;

  // 1. Resolve every line against the live catalogue. Client prices are ignored.
  const catalogue = indexCatalogue(products);
  const pricedLines: {
    sku: string;
    product: Product;
    quantity: number;
    unitPriceCents: number;
    variantName?: string;
  }[] = [];

  for (const line of normalized) {
    const entry = catalogue.get(line.sku);
    if (!entry) {
      return fail(400, `SKU ${line.sku} is not in the catalogue.`, { sku: line.sku });
    }
    if (entry.product.status !== 'ACTIVE') {
      return fail(400, `SKU ${line.sku} is not available for sale.`, { sku: line.sku });
    }
    if (!Number.isInteger(entry.unitPriceCents) || entry.unitPriceCents <= 0) {
      return fail(422, `SKU ${line.sku} has no valid price configured.`, { sku: line.sku });
    }
    pricedLines.push({
      sku: line.sku,
      product: entry.product,
      quantity: line.quantity,
      unitPriceCents: entry.unitPriceCents,
      variantName: entry.variantName,
    });
  }

  // 2. Reserve atomically, newest first-touch last. Any failure unwinds the lot.
  const sequence = await deps.nextOrderId();
  const orderId = generateOrderId(sequence);
  const reservationIds: string[] = [];
  const warnings: string[] = [];

  try {
    for (const line of pricedLines) {
      const reservation = await state.reserve(tenant.id, {
        orderId,
        sku: line.sku,
        quantity: line.quantity,
        ttlMinutes: tenant.reservationTTLMinutes || 15,
      });

      if (!reservation.success) {
        for (const reservationId of reservationIds) {
          await state.cancel(tenant.id, reservationId);
        }
        return fail(
          409,
          reservation.error || `Insufficient stock for ${line.product.title}.`,
          { sku: line.sku, availableStock: reservation.availableStock }
        );
      }

      if (reservation.reservation) reservationIds.push(reservation.reservation.id);
    }
  } catch (error) {
    for (const reservationId of reservationIds) {
      await state.cancel(tenant.id, reservationId).catch(() => undefined);
    }
    throw error;
  }

  // 3. Price from catalogue values only.
  const pricing = calculateOrderPricing({
    items: pricedLines.map((line) => ({
      sku: line.sku,
      unitPriceCents: line.unitPriceCents,
      quantity: line.quantity,
    })),
    currency: tenant.currency,
    taxRatePercent: tenant.taxRatePercent,
    taxInclusive: tenant.taxInclusive,
    shippingCountryCode: request.shippingAddress.countryCode,
    discountCode: request.discountCode,
  });

  if (
    typeof request.claimedTotalCents === 'number' &&
    Number.isFinite(request.claimedTotalCents) &&
    request.claimedTotalCents !== pricing.totalCents
  ) {
    warnings.push(
      `Client claimed a total of ${request.claimedTotalCents} but the catalogue prices the order at ${pricing.totalCents}.`
    );
  }

  const orderItems: OrderItem[] = pricedLines.map((line) => ({
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    productId: line.product.id,
    sku: line.sku,
    title: line.product.title,
    variantName: line.variantName,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    subtotalCents: line.unitPriceCents * line.quantity,
  }));

  const isCashOnDelivery = request.paymentMethod === 'CASH_ON_DELIVERY';
  // Prepaid orders wait for a verified payment event. COD is confirmed on credit.
  const status = isCashOnDelivery ? 'CONFIRMED' : 'AWAITING_PAYMENT';
  const now = new Date().toISOString();

  if (isCashOnDelivery) {
    // Cash on delivery ships against the reservation, so commit it immediately.
    for (const reservationId of reservationIds) {
      await state.commit(tenant.id, reservationId);
    }
  }

  const city = request.shippingAddress.city?.toLowerCase() || '';
  const carrier = city.includes('nairobi') ? 'Sendy / Nairobi Boda Courier' : 'Fargo Courier Kenya';
  const etimsInvoiceNumber = `eTIMS-2026-NBI-${String(sequence).padStart(5, '0')}`;
  // No receipt code is generated here. A receipt is issued by Safaricom and
  // arrives through the payment callback; inventing one would be evidence for a
  // payment that never happened.

  const order: Order = {
    id: orderId,
    tenantId: tenant.id,
    customerId: request.customer.id || `cust-${now}-${Math.random().toString(36).slice(2, 8)}`,
    customerName: request.customer.name.trim(),
    customerEmail: request.customer.email.trim().toLowerCase(),
    customerPhone: request.customer.phone || request.mpesaPhoneNumber,
    items: orderItems,
    currency: tenant.currency,
    subtotalCents: pricing.subtotalCents,
    taxCents: pricing.taxCents,
    shippingCents: pricing.shippingCents,
    discountCents: pricing.discountCents,
    totalCents: pricing.totalCents,
    status,
    paymentMethod: request.paymentMethod,
    isPaid: false,
    paymentTransactionRef: undefined,
    mpesaReceiptCode: undefined,
    mpesaPhoneNumber: request.mpesaPhoneNumber,
    etimsInvoiceNumber,
    shippingCarrier: carrier,
    shippingAddress: request.shippingAddress,
    reservationId: reservationIds[0],
    auditTrail: [
      {
        id: `aud-${Date.now()}-init`,
        timestamp: now,
        fromStatus: 'DRAFT',
        toStatus: status,
        actor: request.customer.email.trim().toLowerCase(),
        actorRole: 'CUSTOMER',
        reason: isCashOnDelivery
          ? `Cash on delivery order created. Reserved stock committed. Carrier: ${carrier}.`
          : `Order created server-side; stock reserved for ${tenant.reservationTTLMinutes} minutes pending verified payment.`,
        metadata: {
          reservationIds,
          pricingSource: 'CATALOGUE',
          priceSnapshot: pricing.breakdown,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      },
    ],
    notes: request.notes,
    createdAt: now,
    updatedAt: now,
  };

  return { ok: true, order, reservationIds, warnings };
}
