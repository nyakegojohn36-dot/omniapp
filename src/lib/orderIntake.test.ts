import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderFromIntake } from './orderIntake.ts';
import { InMemoryCommerceState } from './commerceState.ts';
import { calculateOrderPricing } from './pricingEngine.ts';
import { SEED_INVENTORIES, SEED_PRODUCTS, SEED_TENANTS } from './sampleData.ts';
import type { OrderAddress, Product, Tenant } from './types.ts';

const TENANT: Tenant = SEED_TENANTS[0];

const ADDRESS: OrderAddress = {
  fullName: 'Sarah Nekesa',
  addressLine1: '12 Riverside Drive',
  city: 'Nairobi',
  postalCode: '00100',
  countryCode: 'KE',
  phone: '+254712345678',
};

function warehouse(options?: { products?: Product[]; tenant?: Tenant; inventory?: typeof SEED_INVENTORIES }) {
  const tenant = options?.tenant || TENANT;
  const state = new InMemoryCommerceState({
    tenantId: tenant.id,
    inventory: options?.inventory || SEED_INVENTORIES,
    products: options?.products || SEED_PRODUCTS,
  });
  let sequence = 41;
  return {
    tenant,
    state,
    products: options?.products || SEED_PRODUCTS,
    nextOrderId: async () => ++sequence,
  };
}

function request(overrides: Partial<Parameters<typeof createOrderFromIntake>[0]> = {}) {
  return {
    items: [{ sku: 'TSHIRT001', quantity: 1 }],
    customer: { name: 'Sarah Nekesa', email: 'sarah.nekesa@gmail.com' },
    shippingAddress: ADDRESS,
    paymentMethod: 'MPESA_PAYBILL' as const,
    ...overrides,
  };
}

test('order intake: prices and totals come from the catalogue, not the request', async () => {
  const deps = warehouse();
  const tshirt = SEED_PRODUCTS.find((p) => p.sku === 'TSHIRT001')!;

  const result = await createOrderFromIntake(
    {
      ...request(),
      // A forged checkout: one shilling for a 4,800 KSh shirt.
      items: [{ sku: 'TSHIRT001', quantity: 2 }],
      claimedTotalCents: 100,
    },
    deps
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.order.items[0].unitPriceCents, tshirt.basePriceCents);
  assert.equal(result.order.items[0].subtotalCents, tshirt.basePriceCents * 2);

  const expected = calculateOrderPricing({
    items: [{ sku: 'TSHIRT001', unitPriceCents: tshirt.basePriceCents, quantity: 2 }],
    currency: TENANT.currency,
    taxRatePercent: TENANT.taxRatePercent,
    taxInclusive: TENANT.taxInclusive,
    shippingCountryCode: 'KE',
  });
  assert.equal(result.order.totalCents, expected.totalCents);
  assert.notEqual(result.order.totalCents, 100);

  // The forged figure is recorded for fraud review instead of being honoured.
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /claimed a total of 100/);
});

test('order intake: a prepaid order is never created as paid', async () => {
  const deps = warehouse();
  const result = await createOrderFromIntake(
    request({ items: [{ sku: 'TSHIRT001', quantity: 1 }] }),
    deps
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.order.status, 'AWAITING_PAYMENT');
  assert.equal(result.order.isPaid, false);
  assert.equal(result.order.paymentTransactionRef, undefined);
  assert.equal(result.reservationIds.length, 1);
});

test('order intake: cash on delivery confirms and commits stock immediately', async () => {
  const deps = warehouse();
  const before = await deps.state.getAvailability(TENANT.id, 'TSHIRT001');

  const result = await createOrderFromIntake(
    request({ items: [{ sku: 'TSHIRT001', quantity: 2 }], paymentMethod: 'CASH_ON_DELIVERY' }),
    deps
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.order.status, 'CONFIRMED');
  assert.equal(result.order.isPaid, false);

  const after = await deps.state.getAvailability(TENANT.id, 'TSHIRT001');
  // Committing swaps reserved units for physical ones: availability is unchanged,
  // the warehouse is two shirts lighter.
  assert.equal(after.availableStock, before.availableStock - 2);
  assert.equal(after.physicalStock, before.physicalStock - 2);

  const reservations = await deps.state.listReservations(TENANT.id, { orderId: result.order.id });
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].status, 'COMMITTED');
});

test('order intake: a failed line rolls back the reservations already taken', async () => {
  const deps = warehouse();
  const before = await deps.state.getAvailability(TENANT.id, 'TSHIRT001');

  const result = await createOrderFromIntake(
    request({
      items: [
        { sku: 'TSHIRT001', quantity: 1 },
        { sku: 'FLASK-VAC-750', quantity: 1 }, // seeded with zero physical stock
      ],
    }),
    deps
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  assert.equal(result.sku, 'FLASK-VAC-750');

  const after = await deps.state.getAvailability(TENANT.id, 'TSHIRT001');
  assert.equal(after.availableStock, before.availableStock, 'the first line must be released');

  const leaked = await deps.state.listReservations(TENANT.id, { status: 'ACTIVE' });
  assert.equal(leaked.length, 0, 'no reservation may survive a rolled-back checkout');
});

test('order intake: rejects malformed lines before touching stock', async () => {
  const deps = warehouse();
  const before = await deps.state.getAvailability(TENANT.id, 'TSHIRT001');

  const cases: { label: string; items: { sku: string; quantity: number }[]; status: number }[] = [
    { label: 'empty basket', items: [], status: 400 },
    { label: 'zero quantity', items: [{ sku: 'TSHIRT001', quantity: 0 }], status: 400 },
    { label: 'negative quantity', items: [{ sku: 'TSHIRT001', quantity: -1 }], status: 400 },
    { label: 'fractional quantity', items: [{ sku: 'TSHIRT001', quantity: 1.5 }], status: 400 },
    { label: 'unknown SKU', items: [{ sku: 'DOES-NOT-EXIST', quantity: 1 }], status: 400 },
  ];

  for (const testCase of cases) {
    const result = await createOrderFromIntake(request({ items: testCase.items }), deps);
    assert.equal(result.ok, false, testCase.label);
    if (result.ok) continue;
    assert.equal(result.status, testCase.status, testCase.label);
  }

  const after = await deps.state.getAvailability(TENANT.id, 'TSHIRT001');
  assert.equal(after.availableStock, before.availableStock);
});

test('order intake: refuses a product that is not for sale', async () => {
  const draft: Product = {
    ...SEED_PRODUCTS[0],
    sku: 'TSHIRT001',
    status: 'DRAFT',
  };
  const deps = warehouse({
    products: [draft, ...SEED_PRODUCTS.filter((p) => p.sku !== 'TSHIRT001')],
  });

  const result = await createOrderFromIntake(request(), deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.match(result.error, /not available for sale/);
});

test('order intake: merges duplicate SKU lines into one reservation', async () => {
  const deps = warehouse();
  const result = await createOrderFromIntake(
    request({
      items: [
        { sku: 'TSHIRT001', quantity: 1 },
        { sku: 'tshirt001', quantity: 2 },
      ],
    }),
    deps
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.order.items.length, 1);
  assert.equal(result.order.items[0].quantity, 3);
  assert.equal(result.reservationIds.length, 1);
});

test('order intake: uses the server order sequence for the id only', async () => {
  const deps = warehouse();
  const result = await createOrderFromIntake(request(), deps);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.order.id, 'ORD-000042');
  // No fiscal reference and no payment receipt are invented at intake. The fields
  // are gone from the type, so this checks the object that actually gets persisted.
  const persisted = result.order as unknown as Record<string, unknown>;
  assert.equal(persisted.etimsInvoiceNumber, undefined);
  assert.equal(persisted.mpesaReceiptCode, undefined);
});

test('order intake: rejects a missing or invalid shipping address', async () => {
  const deps = warehouse();

  const noPostal = await createOrderFromIntake(
    request({ shippingAddress: { ...ADDRESS, postalCode: '' } }),
    deps
  );
  assert.equal(noPostal.ok, false);
  if (!noPostal.ok) assert.equal(noPostal.status, 400);

  const badCountry = await createOrderFromIntake(
    request({ shippingAddress: { ...ADDRESS, countryCode: 'KEN' } }),
    deps
  );
  assert.equal(badCountry.ok, false);
});

test('order intake: resolves a variant SKU to its parent product and variant price', async () => {
  const deps = warehouse();
  const tshirt = SEED_PRODUCTS.find((p) => p.sku === 'TSHIRT001')!;
  const navyMedium = tshirt.variants.find((v) => v.sku === 'TSHIRT001-NVY-M')!;

  const result = await createOrderFromIntake(
    request({ items: [{ sku: 'TSHIRT001-NVY-M', quantity: 1 }] }),
    deps
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.order.items[0].sku, 'TSHIRT001-NVY-M');
  assert.equal(result.order.items[0].productId, tshirt.id);
  assert.equal(result.order.items[0].title, tshirt.title);
  assert.equal(result.order.items[0].variantName, navyMedium.name);
  assert.equal(result.order.items[0].unitPriceCents, navyMedium.priceCents);
});

test('order intake: leaves the carrier to fulfilment instead of inventing one', async () => {
  // The destination city used to pick a courier name and a tracking number here.
  // Both were fabricated: no courier had been booked. Fulfilment records the real
  // carrier when the parcel is actually handed over.
  const nairobi = warehouse();
  const nairobiOrder = await createOrderFromIntake(request(), nairobi);
  assert.equal(nairobiOrder.ok, true);
  if (!nairobiOrder.ok) return;
  assert.equal(nairobiOrder.order.shippingCarrier, undefined);
  assert.equal(nairobiOrder.order.trackingNumber, undefined);

  const upcountry = warehouse();
  const upcountryOrder = await createOrderFromIntake(
    request({ shippingAddress: { ...ADDRESS, city: 'Nakuru' } }),
    upcountry
  );
  assert.equal(upcountryOrder.ok, true);
  if (!upcountryOrder.ok) return;
  assert.equal(upcountryOrder.order.shippingCarrier, undefined);
});
