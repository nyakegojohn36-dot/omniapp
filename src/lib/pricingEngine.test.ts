import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOrderPricing, formatCurrency } from './pricingEngine.ts';

test('Pricing Engine: calculates subtotal and tax correctly with no floating-point inaccuracies', () => {
  const result = calculateOrderPricing({
    items: [
      { sku: 'TSHIRT001', unitPriceCents: 3200, quantity: 2 }, // 6400 cents ($64.00)
      { sku: 'CAP001', unitPriceCents: 1850, quantity: 1 },    // 1850 cents ($18.50)
    ],
    currency: 'USD',
    taxRatePercent: 8.5,
    taxInclusive: false,
    shippingCountryCode: 'US',
  });

  assert.equal(result.subtotalCents, 8250); // $82.50
  assert.equal(result.shippingCents, 850);  // $8.50
  // Tax on $82.50 @ 8.5% = 701.25 -> rounded to 701 cents
  assert.equal(result.taxCents, 701);
  // Total = 8250 + 850 + 701 = 9801 cents ($98.01)
  assert.equal(result.totalCents, 9801);
  assert.ok(result.formattedTotal.includes('98.01'));
});

test('Pricing Engine: applies percentage discount vouchers properly', () => {
  const result = calculateOrderPricing({
    items: [{ sku: 'TSHIRT001', unitPriceCents: 10000, quantity: 1 }], // $100
    currency: 'USD',
    taxRatePercent: 0,
    taxInclusive: false,
    shippingCountryCode: 'US',
    discountCode: 'WELCOME10', // 10% off
  });

  assert.equal(result.subtotalCents, 10000);
  assert.equal(result.discountCents, 1000); // $10 off
  assert.equal(result.totalCents, 9850); // 9000 + 850 shipping
});

test('Pricing Engine: applies free shipping over threshold', () => {
  const result = calculateOrderPricing({
    items: [{ sku: 'JACKET001', unitPriceCents: 15000, quantity: 1 }], // $150
    currency: 'EUR',
    taxRatePercent: 19,
    taxInclusive: true, // VAT inclusive
    shippingCountryCode: 'DE',
  });

  assert.equal(result.shippingCents, 0); // Free shipping over $100/€100
  assert.equal(result.totalCents, 15000);
  // Tax included in €150 @ 19% = 15000 - 15000 / 1.19 = 2395 cents
  assert.equal(result.taxCents, 2395);
});
