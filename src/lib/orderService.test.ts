import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerOrder, generateOrderId, validateOrderAddress } from './orderService.ts';
import { InventoryStore } from './inventoryEngine.ts';
import { SEED_INVENTORIES, SEED_TENANTS } from './sampleData.ts';

test('Order Service: generates sequential order IDs with leading zeros', () => {
  assert.equal(generateOrderId(8), 'ORD-000008');
  assert.equal(generateOrderId(9), 'ORD-000009');
  assert.equal(generateOrderId(142), 'ORD-000142');
});

test('Order Service: validates address completeness', () => {
  const badAddr = {
    fullName: '',
    addressLine1: '',
    city: '',
    postalCode: '',
    countryCode: '',
    phone: '',
  };
  const checkBad = validateOrderAddress(badAddr);
  assert.equal(checkBad.valid, false);

  const goodAddr = {
    fullName: 'Jane Doe',
    addressLine1: '123 Market St',
    city: 'Seattle',
    postalCode: '98101',
    countryCode: 'US',
    phone: '+1 555-0100',
  };
  const checkGood = validateOrderAddress(goodAddr);
  assert.equal(checkGood.valid, true);
});

test('Order Service: successfully creates order, reserves stock, and calculates pricing', () => {
  const store = new InventoryStore(SEED_INVENTORIES);
  const result = createCustomerOrder({
    tenant: SEED_TENANTS[0],
    inventoryEngine: store,
    customerName: 'Marcus Cole',
    customerEmail: 'marcus@example.com',
    existingOrderIdCount: 8,
    items: [
      {
        productId: 'prod-tshirt-01',
        sku: 'TSHIRT001',
        title: 'Merino Wool Trail Crewneck T-Shirt',
        unitPriceCents: 4800,
        quantity: 2,
      },
    ],
    shippingAddress: {
      fullName: 'Marcus Cole',
      addressLine1: 'Road A, Industrial Area',
      city: 'Nairobi',
      postalCode: '00100',
      countryCode: 'KE',
      phone: '+254 711 000111',
    },
    paymentMethod: 'CREDIT_CARD',
    prepaidApproved: false,
  });

  assert.equal(result.success, true);
  assert.ok(result.order);
  assert.equal(result.order?.id, 'ORD-000009');
  assert.equal(result.order?.status, 'AWAITING_PAYMENT');
  assert.equal(result.order?.subtotalCents, 9600); // 2 * 4800
  assert.equal(result.order?.shippingCents, 30000); // KSh 300 Nairobi Boda dispatch
  assert.equal(result.order?.isPaid, false);

  // Check inventory reserved
  const stock = store.getAvailability('TSHIRT001');
  assert.equal(stock.reservedStock, 4); // 2 seed + 2 new
});

test('Order Service: rejects order when item is completely out of stock', () => {
  const store = new InventoryStore(SEED_INVENTORIES);
  const result = createCustomerOrder({
    tenant: SEED_TENANTS[0],
    inventoryEngine: store,
    customerName: 'Marcus Cole',
    customerEmail: 'marcus@example.com',
    existingOrderIdCount: 8,
    items: [
      {
        productId: 'prod-flask-03',
        sku: 'FLASK-VAC-750', // Out of stock item
        title: 'Vacuum Thermal Trail Flask',
        unitPriceCents: 3400,
        quantity: 1,
      },
    ],
    shippingAddress: {
      fullName: 'Marcus Cole',
      addressLine1: '456 Pine St',
      city: 'Portland',
      postalCode: '97201',
      countryCode: 'US',
      phone: '+1 555-0144',
    },
    paymentMethod: 'CREDIT_CARD',
  });

  assert.equal(result.success, false);
  assert.match(result.error || '', /completely out of stock/);
});

test('Order Service: Cash on Delivery orders transition directly to CONFIRMED and commit stock', () => {
  const store = new InventoryStore(SEED_INVENTORIES);
  const initialPhysical = store.getAvailability('TSHIRT001').physicalStock;

  const result = createCustomerOrder({
    tenant: SEED_TENANTS[0],
    inventoryEngine: store,
    customerName: 'COD Customer',
    customerEmail: 'cod@example.com',
    existingOrderIdCount: 8,
    items: [
      {
        productId: 'prod-tshirt-01',
        sku: 'TSHIRT001',
        title: 'Merino Wool Trail Crewneck T-Shirt',
        unitPriceCents: 4800,
        quantity: 1,
      },
    ],
    shippingAddress: {
      fullName: 'COD Customer',
      addressLine1: '789 Elm St',
      city: 'Austin',
      postalCode: '73301',
      countryCode: 'US',
      phone: '+1 555-0188',
    },
    paymentMethod: 'CASH_ON_DELIVERY',
  });

  assert.equal(result.success, true);
  assert.equal(result.order?.status, 'CONFIRMED');
  assert.equal(result.order?.isPaid, false); // Not paid yet, but confirmed under COD policy

  // Stock committed immediately (physical deducted)
  const afterPhysical = store.getAvailability('TSHIRT001').physicalStock;
  assert.equal(afterPhysical, initialPhysical - 1);
});
