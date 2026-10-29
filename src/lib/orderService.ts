/**
 * Order Service - Core Order Creation and Checkout Workflow
 * Authoritative pipeline that validates items, reserves stock,
 * calculates pricing snapshots, and persists orders.
 */

import { InventoryStore } from './inventoryEngine.ts';
import { calculateOrderPricing, type PricingInputItem } from './pricingEngine.ts';
import type { Order, OrderAddress, OrderItem, PaymentMethod, Tenant } from './types.ts';

export interface CreateOrderParams {
  tenant: Tenant;
  inventoryEngine: InventoryStore;
  customerId?: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  items: {
    productId: string;
    sku: string;
    title: string;
    variantName?: string;
    unitPriceCents: number;
    quantity: number;
  }[];
  shippingAddress: OrderAddress;
  paymentMethod: PaymentMethod;
  discountCode?: string;
  mpesaPhoneNumber?: string;
  mpesaReceiptCode?: string;
  existingOrderIdCount: number;
  prepaidApproved?: boolean;
}

export interface CreateOrderResult {
  success: boolean;
  order?: Order;
  reservationId?: string;
  error?: string;
}

/**
 * Format sequential order ID e.g. ORD-000009
 */
export function generateOrderId(sequenceNumber: number): string {
  const padded = String(sequenceNumber).padStart(6, '0');
  return `ORD-${padded}`;
}

/**
 * Validates shipping address fields
 */
export function validateOrderAddress(address: OrderAddress): { valid: boolean; error?: string } {
  if (!address.fullName?.trim()) return { valid: false, error: 'Full name is required.' };
  if (!address.addressLine1?.trim()) return { valid: false, error: 'Street address is required.' };
  if (!address.city?.trim()) return { valid: false, error: 'City is required.' };
  if (!address.postalCode?.trim()) return { valid: false, error: 'Postal code is required.' };
  if (!address.countryCode?.trim() || address.countryCode.length !== 2) {
    return { valid: false, error: 'Valid 2-letter country code is required.' };
  }
  return { valid: true };
}

/**
 * Creates, validates, and initializes an order through the authoritative pipeline
 */
export function createCustomerOrder(params: CreateOrderParams): CreateOrderResult {
  const {
    tenant,
    inventoryEngine,
    customerId = `cust-${Date.now()}`,
    customerName,
    customerEmail,
    customerPhone,
    items,
    shippingAddress,
    paymentMethod,
    discountCode,
    existingOrderIdCount,
    prepaidApproved = false,
  } = params;

  // 1. Validate customer info
  if (!customerName?.trim()) {
    return { success: false, error: 'Customer name is required.' };
  }
  if (!customerEmail?.includes('@')) {
    return { success: false, error: 'Valid customer email is required.' };
  }

  // 2. Validate address
  const addrValidation = validateOrderAddress(shippingAddress);
  if (!addrValidation.valid) {
    return { success: false, error: addrValidation.error };
  }

  // 3. Validate items
  if (!items || items.length === 0) {
    return { success: false, error: 'Order must contain at least one item.' };
  }

  const generatedId = generateOrderId(existingOrderIdCount + 1);

  // 4. Concurrency-safe atomic inventory reservation for each item
  const reservationsMade: string[] = [];
  for (const item of items) {
    if (item.quantity <= 0) {
      return { success: false, error: `Invalid quantity for SKU ${item.sku}.` };
    }

    const res = inventoryEngine.reserveStock({
      tenantId: tenant.id,
      orderId: generatedId,
      sku: item.sku,
      quantity: item.quantity,
      ttlMinutes: tenant.reservationTTLMinutes,
    });

    if (!res.success) {
      // Rollback any earlier reservations in this order
      for (const resId of reservationsMade) {
        inventoryEngine.cancelReservation(resId);
      }
      return {
        success: false,
        error: `Inventory check failed for ${item.title}: ${res.error}`,
      };
    }

    if (res.reservation) {
      reservationsMade.push(res.reservation.id);
    }
  }

  // 5. Authoritative precision pricing calculation
  const pricingItems: PricingInputItem[] = items.map((i) => ({
    sku: i.sku,
    unitPriceCents: i.unitPriceCents,
    quantity: i.quantity,
  }));

  const pricing = calculateOrderPricing({
    items: pricingItems,
    currency: tenant.currency,
    taxRatePercent: tenant.taxRatePercent,
    taxInclusive: tenant.taxInclusive,
    shippingCountryCode: shippingAddress.countryCode,
    discountCode,
  });

  // 6. Build immutable order items snapshot
  const orderItemsSnapshot: OrderItem[] = items.map((i) => ({
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    productId: i.productId,
    sku: i.sku,
    title: i.title,
    variantName: i.variantName,
    quantity: i.quantity,
    unitPriceCents: i.unitPriceCents,
    subtotalCents: i.unitPriceCents * i.quantity,
  }));

  const now = new Date().toISOString();
  const isPrepaid = paymentMethod !== 'CASH_ON_DELIVERY';
  const isPaid = isPrepaid && prepaidApproved;
  const initialStatus = isPaid ? 'CONFIRMED' : isPrepaid ? 'AWAITING_PAYMENT' : 'CONFIRMED';

  // If order is confirmed immediately (e.g. COD or payment authorized), commit reservations
  if (initialStatus === 'CONFIRMED') {
    for (const resId of reservationsMade) {
      inventoryEngine.commitReservation(resId);
    }
  }

  const primaryReservationId = reservationsMade[0];
  const generatedMpesaReceipt =
    params.mpesaReceiptCode ||
    (paymentMethod === 'MPESA_EXPRESS' || paymentMethod === 'MPESA_PAYBILL'
      ? `QK${Math.floor(10000000 + Math.random() * 90000000)}`
      : undefined);
  const etimsNumber = `eTIMS-2026-NBI-${String(existingOrderIdCount + 1).padStart(5, '0')}`;
  const defaultCarrier = shippingAddress.city?.toLowerCase().includes('nairobi')
    ? 'Sendy / Nairobi Boda Courier'
    : 'Fargo Courier Kenya';

  const order: Order = {
    id: generatedId,
    tenantId: tenant.id,
    customerId,
    customerName,
    customerEmail,
    customerPhone: customerPhone || params.mpesaPhoneNumber,
    mpesaPhoneNumber: params.mpesaPhoneNumber,
    mpesaReceiptCode: generatedMpesaReceipt,
    etimsInvoiceNumber: etimsNumber,
    shippingCarrier: defaultCarrier,
    items: orderItemsSnapshot,
    currency: tenant.currency,
    subtotalCents: pricing.subtotalCents,
    taxCents: pricing.taxCents,
    shippingCents: pricing.shippingCents,
    discountCents: pricing.discountCents,
    totalCents: pricing.totalCents,
    status: initialStatus,
    paymentMethod,
    isPaid,
    paymentTransactionRef: isPaid
      ? generatedMpesaReceipt || `tx_auth_${Date.now()}`
      : undefined,
    shippingAddress,
    reservationId: primaryReservationId,
    auditTrail: [
      {
        id: `aud-${Date.now()}-init`,
        timestamp: now,
        fromStatus: 'DRAFT',
        toStatus: initialStatus,
        actor: customerEmail,
        actorRole: 'CUSTOMER',
        reason: isPaid
          ? paymentMethod === 'MPESA_EXPRESS'
            ? `Order confirmed & M-PESA STK Push verified (${pricing.formattedTotal}, Ref: ${generatedMpesaReceipt}). KRA eTIMS invoice ${etimsNumber} issued. Stock committed.`
            : `Checkout placed & payment authorized (${pricing.formattedTotal}). Stock committed.`
          : paymentMethod === 'CASH_ON_DELIVERY'
          ? `Order placed with Cash / M-PESA on Delivery terms. Carrier: ${defaultCarrier}. Stock committed.`
          : `Order placed. Awaiting M-PESA / payment confirmation. Stock reserved for ${tenant.reservationTTLMinutes} mins.`,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };

  return {
    success: true,
    order,
    reservationId: primaryReservationId,
  };
}
