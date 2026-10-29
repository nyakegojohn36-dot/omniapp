import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransitionOrder, transitionOrder } from './orderStateMachine.ts';
import type { Order } from './types.ts';

const mockOrder: Order = {
  id: 'ORD-000008',
  tenantId: 'tenant-nordic',
  customerId: 'cust-101',
  customerName: 'Sarah Jenkins',
  customerEmail: 'sarah@example.com',
  items: [
    {
      id: 'item-1',
      productId: 'prod-tshirt',
      sku: 'TSHIRT001',
      title: 'Performance Crewneck T-Shirt',
      quantity: 2,
      unitPriceCents: 3200,
      subtotalCents: 6400,
    },
  ],
  currency: 'USD',
  subtotalCents: 6400,
  taxCents: 512,
  shippingCents: 850,
  discountCents: 0,
  totalCents: 7762,
  status: 'AWAITING_PAYMENT',
  paymentMethod: 'CREDIT_CARD',
  isPaid: false,
  shippingAddress: {
    fullName: 'Sarah Jenkins',
    addressLine1: '742 Evergreen Terrace',
    city: 'Springfield',
    stateOrProvince: 'OR',
    postalCode: '97477',
    countryCode: 'US',
    phone: '+1 555-0199',
  },
  auditTrail: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

test('Order State Machine: blocks prepaid order from entering CONFIRMED without payment verification', () => {
  const result = canTransitionOrder(
    'AWAITING_PAYMENT',
    'CONFIRMED',
    {
      actor: 'system',
      actorRole: 'SYSTEM',
      reason: 'Automated check',
      paymentConfirmed: false,
    },
    mockOrder
  );
  assert.equal(result.allowed, false);
  assert.match(result.reason || '', /Prepaid order cannot enter CONFIRMED status without verified payment/);
});

test('Order State Machine: allows prepaid order to enter CONFIRMED once payment is verified', () => {
  const transition = transitionOrder(mockOrder, 'CONFIRMED', {
    actor: 'stripe-webhook',
    actorRole: 'SYSTEM',
    reason: 'Payment intent charge succeeded',
    paymentConfirmed: true,
  });

  assert.equal(transition.success, true);
  assert.equal(transition.order.status, 'CONFIRMED');
  assert.equal(transition.order.isPaid, true);
  assert.equal(transition.order.auditTrail.length, 1);
  assert.equal(transition.order.auditTrail[0].toStatus, 'CONFIRMED');
});

test('Order State Machine: prohibits invalid skip transitions (e.g. DRAFT straight to DELIVERED)', () => {
  const draftOrder: Order = { ...mockOrder, status: 'DRAFT' };
  const result = canTransitionOrder(
    'DRAFT',
    'DELIVERED',
    {
      actor: 'staff',
      actorRole: 'FULFILLMENT_STAFF',
      reason: 'Manual attempt',
    },
    draftOrder
  );
  assert.equal(result.allowed, false);
  assert.match(result.reason || '', /Illegal state transition/);
});

test('Order State Machine: requires tracking or carrier info before transitioning to SHIPPED', () => {
  const confirmedOrder: Order = { ...mockOrder, status: 'READY_FOR_DISPATCH', isPaid: true };
  const failedAttempt = transitionOrder(confirmedOrder, 'SHIPPED', {
    actor: 'warehouse-1',
    actorRole: 'FULFILLMENT_STAFF',
    reason: 'Package picked',
    trackingNumberProvided: false,
    carrierProvided: false,
  });

  assert.equal(failedAttempt.success, false);
  assert.match(failedAttempt.error || '', /without a carrier or tracking reference/);

  const successfulAttempt = transitionOrder(confirmedOrder, 'SHIPPED', {
    actor: 'warehouse-1',
    actorRole: 'FULFILLMENT_STAFF',
    reason: 'DHL label scanned',
    carrierProvided: true,
    trackingNumberProvided: true,
    metadata: {
      shippingCarrier: 'DHL Express',
      trackingNumber: 'DHL-98421094',
    },
  });

  assert.equal(successfulAttempt.success, true);
  assert.equal(successfulAttempt.order.status, 'SHIPPED');
  assert.equal(successfulAttempt.order.shippingCarrier, 'DHL Express');
});

test('Order State Machine: prevents customer role from directly issuing refunds or setting on hold', () => {
  const processingOrder: Order = { ...mockOrder, status: 'PROCESSING', isPaid: true };
  const custResult = canTransitionOrder(
    'PROCESSING',
    'ON_HOLD',
    {
      actor: 'sarah@example.com',
      actorRole: 'CUSTOMER',
      reason: 'Hold please',
    },
    processingOrder
  );
  assert.equal(custResult.allowed, false);
  assert.match(custResult.reason || '', /requires staff review/);
});
