import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { WhatsAppCloudService } from './whatsappCloudService.ts';
import { InventoryStore } from './inventoryEngine.ts';
import { SEED_INVENTORIES, SEED_ORDERS, SEED_PRODUCTS, SEED_TENANTS } from './sampleData.ts';
import type { Order } from './types.ts';

test('WhatsApp Cloud Service: verifies Meta webhook handshake correctly', () => {
  const service = new WhatsAppCloudService({ verifyToken: 'test_token_123' });
  const success = service.verifyWebhook({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'test_token_123',
    'hub.challenge': '9948271',
  });
  assert.equal(success.verified, true);
  assert.equal(success.challenge, '9948271');

  const fail = service.verifyWebhook({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'wrong_token',
  });
  assert.equal(fail.verified, false);
});

test('WhatsApp Cloud Service: does not accept a fallback or unconfigured webhook token', () => {
  const service = new WhatsAppCloudService();
  const defaultTokenAttempt = service.verifyWebhook({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'omni_whatsapp_verify_token_2026',
    'hub.challenge': 'challenge',
  });
  assert.equal(defaultTokenAttempt.verified, false);

  const configuredService = new WhatsAppCloudService({ verifyToken: 'private-test-token' });
  const mismatch = configuredService.verifyWebhook({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'wrong-token',
    'hub.challenge': 'challenge',
  });
  assert.equal(mismatch.verified, false);
  assert.equal(mismatch.error?.includes('private-test-token'), false);
});

test('WhatsApp Cloud Service: defaults to an unconnected simulated configuration', () => {
  const config = new WhatsAppCloudService().getConfig();
  assert.equal(config.mode, 'SIMULATED_DEMO');
  assert.equal(config.configurationSaved, false);
  assert.equal(config.credentialsValidated, false);
  assert.equal(config.webhookVerified, false);
  assert.equal(config.hasAccessToken, false);
});

test('WhatsApp Cloud Service: completes full multi-step order placement journey via WhatsApp', () => {
  const inventoryEngine = new InventoryStore(SEED_INVENTORIES);
  const products = [...SEED_PRODUCTS];
  const orders: Order[] = [...SEED_ORDERS];
  let createdOrder: Order | null = null;

  const service = new WhatsAppCloudService();
  const phone = '+1 (555) 987-6543';
  const name = 'David Miller';

  // Step 1: Customer asks to buy TSHIRT001
  const step1 = service.processInboundMessage({
    messageId: 'mid-step-1',
    fromNumber: phone,
    customerName: name,
    textBody: 'Hi, I want to buy 2 pairs of TSHIRT001',
    inventoryEngine,
    products,
    orders,
    tenant: SEED_TENANTS[0],
    onOrderCreated: (ord) => {
      createdOrder = ord;
      orders.unshift(ord);
    },
  });

  assert.ok(step1.responseText.includes('Order Setup'));
  assert.ok(step1.responseText.includes('Merino Wool') && step1.responseText.includes('T-Shirt'));
  assert.ok(step1.responseText.includes('Please provide your delivery address'));
  assert.equal(createdOrder, null);

  // Step 2: Customer provides shipping address
  const step2 = service.processInboundMessage({
    messageId: 'mid-step-2',
    fromNumber: phone,
    customerName: name,
    textBody: '450 Pine Road, Portland, 97201',
    inventoryEngine,
    products,
    orders,
    tenant: SEED_TENANTS[0],
    onOrderCreated: (ord) => {
      createdOrder = ord;
      orders.unshift(ord);
    },
  });

  assert.ok(step2.responseText.includes('Please Confirm Your Order'));
  assert.ok(step2.responseText.includes('450 Pine Road'));
  assert.ok(step2.responseText.includes('Reply *YES* to confirm'));
  assert.equal(createdOrder, null);

  // Initial stock before confirmation
  const stockBefore = inventoryEngine.getAvailability('TSHIRT001');

  // Step 3: Customer confirms with "YES"
  const step3 = service.processInboundMessage({
    messageId: 'mid-step-3',
    fromNumber: phone,
    customerName: name,
    textBody: 'YES',
    inventoryEngine,
    products,
    orders,
    tenant: SEED_TENANTS[0],
    onOrderCreated: (ord) => {
      createdOrder = ord;
      orders.unshift(ord);
    },
  });

  assert.ok(step3.responseText.includes('Order Confirmed! Ref: ORD-'));
  assert.ok(step3.responseText.includes('AWAITING PAYMENT'));
  assert.ok(createdOrder !== null);

  // Check order properties
  const ord: Order = createdOrder!;
  assert.equal(ord.sourceChannel, 'WHATSAPP');
  assert.equal(ord.whatsappSenderPhone, phone);
  assert.equal(ord.customerName, name);
  assert.equal(ord.status, 'AWAITING_PAYMENT');
  assert.equal(ord.items[0].sku, 'TSHIRT001');
  assert.equal(ord.items[0].quantity, 2);

  // Check that stock was atomically reserved
  const stockAfter = inventoryEngine.getAvailability('TSHIRT001');
  assert.equal(stockAfter.availableStock, stockBefore.availableStock - 2);
  assert.ok(ord.reservationId);
});

test('WhatsApp Cloud Service: refuses to order out-of-stock item and suggests alternatives', () => {
  const inventoryEngine = new InventoryStore(SEED_INVENTORIES);
  const service = new WhatsAppCloudService();

  const res = service.processInboundMessage({
    messageId: 'mid-oos-1',
    fromNumber: '+1 (555) 777-8888',
    customerName: 'Alex Test',
    textBody: 'I want to order FLASK-VAC-750',
    inventoryEngine,
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });

  assert.ok(res.responseText.includes('Out of Stock'));
  assert.ok(res.responseText.includes('TSHIRT001'));
});

test('WhatsApp Cloud Service: enforces idempotency on duplicate webhook message IDs', () => {
  const inventoryEngine = new InventoryStore(SEED_INVENTORIES);
  const service = new WhatsAppCloudService();

  const first = service.processInboundMessage({
    messageId: 'wamid-dup-test-01',
    fromNumber: '+1 (555) 111-2222',
    customerName: 'First Run',
    textBody: 'Do you have TSHIRT001 in stock?',
    inventoryEngine,
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });
  assert.ok(first.responseText.includes('Merino Wool Trail Crewneck T-Shirt'));

  const second = service.processInboundMessage({
    messageId: 'wamid-dup-test-01', // duplicate ID!
    fromNumber: '+1 (555) 111-2222',
    customerName: 'First Run',
    textBody: 'Do you have TSHIRT001 in stock?',
    inventoryEngine,
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });
  assert.equal(second.responseText, 'This request was already processed.');
});

test('WhatsApp Cloud Service: pauses AI replies during human support takeover', () => {
  const inventoryEngine = new InventoryStore(SEED_INVENTORIES);
  const service = new WhatsAppCloudService();
  const phone = '+1 (555) 444-5555';

  // Customer asks for human
  const escalation = service.processInboundMessage({
    messageId: 'wamid-human-1',
    fromNumber: phone,
    customerName: 'Emma Watson',
    textBody: 'I want to speak with an agent',
    inventoryEngine,
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });

  assert.equal(escalation.humanTakeoverActive, true);
  assert.ok(escalation.responseText.includes('connected to our human support team'));

  // Subsequent message from customer should have AI paused
  const followup = service.processInboundMessage({
    messageId: 'wamid-human-2',
    fromNumber: phone,
    customerName: 'Emma Watson',
    textBody: 'My item arrived broken',
    inventoryEngine,
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });

  assert.equal(followup.humanTakeoverActive, true);
  assert.ok(followup.responseText.includes('Automated replies paused'));

  // Return to AI
  const resume = service.processInboundMessage({
    messageId: 'wamid-human-3',
    fromNumber: phone,
    customerName: 'Emma Watson',
    textBody: 'RETURN TO AI',
    inventoryEngine,
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });

  assert.equal(resume.humanTakeoverActive, false);
  assert.ok(resume.responseText.includes('Automated AI assistant is active again'));
});

test('WhatsApp Cloud Service: masks secrets in logs and diagnostic outputs', () => {
  const service = new WhatsAppCloudService({}, 'EAAG982736192847162837192837192837xK9');
  const conf = service.getConfig();
  assert.equal(conf.hasAccessToken, true);
  assert.equal(conf.accessTokenMasked, 'EAAG...7xK9');
  assert.ok(!JSON.stringify(conf).includes('982736192847162837192837192837'));
});

test('WhatsApp Cloud Service: verifies incoming Meta webhook HMAC-SHA256 signature', () => {
  const appSecret = 'meta_test_secret_key_84920';
  const service = new WhatsAppCloudService(
    { mode: 'META_TEST' },
    'token123',
    appSecret
  );

  const rawPayload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '123' }],
  });

  const validHmac = crypto.createHmac('sha256', appSecret).update(rawPayload).digest('hex');
  const validHeader = `sha256=${validHmac}`;

  // 1. Valid signature passes
  const check1 = service.verifySignature(rawPayload, validHeader);
  assert.equal(check1.valid, true);

  // 2. Tampered body fails
  const check2 = service.verifySignature(rawPayload + 'tampered', validHeader);
  assert.equal(check2.valid, false);

  // 3. Missing header fails
  const check3 = service.verifySignature(rawPayload, undefined);
  assert.equal(check3.valid, false);

  // 4. In LIVE_PRODUCTION mode, missing App Secret fails
  const prodServiceWithoutSecret = new WhatsAppCloudService({ mode: 'LIVE_PRODUCTION' });
  const check4 = prodServiceWithoutSecret.verifySignature(rawPayload, validHeader);
  assert.equal(check4.valid, false);

  const testServiceWithoutSecret = new WhatsAppCloudService({ mode: 'META_TEST' });
  const check5 = testServiceWithoutSecret.verifySignature(rawPayload, validHeader);
  assert.equal(check5.valid, false);
});

test('WhatsApp Cloud Service: preserves existing secrets when updating configuration without raw tokens', () => {
  const service = new WhatsAppCloudService(
    { wabaId: '100' },
    'EAAG_ORIGINAL_TOKEN_SECRET',
    'ORIGINAL_APP_SECRET_KEY'
  );

  // Verify initial masked values
  assert.equal(service.getConfig().hasAccessToken, true);
  assert.equal(service.getConfig().hasAppSecret, true);

  // Update without passing rawAccessToken or rawAppSecret (e.g. updating display phone or prompt only)
  service.updateConfig({ displayPhoneNumber: '+1 (555) 999-8888' });

  // Secrets must NOT be wiped
  const updatedConf = service.getConfig();
  assert.equal(updatedConf.hasAccessToken, true);
  assert.equal(updatedConf.hasAppSecret, true);
  assert.equal(updatedConf.displayPhoneNumber, '+1 (555) 999-8888');

  // Updating with empty string also preserves existing secrets
  service.updateConfig({ wabaId: '200' }, '', '');
  assert.equal(service.getConfig().hasAccessToken, true);
  assert.equal(service.getConfig().hasAppSecret, true);
});

test('WhatsApp Cloud Service: centralized Graph API version defaults to v22.0 and supports configurable upgrades', () => {
  const service = new WhatsAppCloudService();
  assert.equal(service.getConfig().graphApiVersion, 'v22.0');

  // Upgrade to v26.0
  service.updateConfig({ graphApiVersion: 'v26.0' });
  assert.equal(service.getConfig().graphApiVersion, 'v26.0');
});

test('WhatsApp Cloud Service: strictly enforces customer privacy when tracking orders', () => {
  const service = new WhatsAppCloudService();
  const inventoryEngine = new InventoryStore(SEED_INVENTORIES);

  // Sarah Nekesa (phone +254 752 720933) tracks her own order ORD-000008
  const authTrack = service.processInboundMessage({
    messageId: 'mid-track-auth',
    fromNumber: '+254 752 720933',
    customerName: 'Sarah Nekesa',
    textBody: 'TRACK ORD-000008',
    inventoryEngine,
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });
  assert.ok(authTrack.responseText.includes('ORD-000008'));
  assert.ok(authTrack.responseText.includes('Sarah Nekesa') || authTrack.responseText.includes('Safari Peak'));

  // Unauthorized stranger (+1 (555) 999-4321) tries to snoop on ORD-000008
  const unauthTrack = service.processInboundMessage({
    messageId: 'mid-track-unauth',
    fromNumber: '+1 (555) 999-4321',
    customerName: 'Stranger',
    textBody: 'TRACK ORD-000008',
    inventoryEngine,
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });
  assert.ok(unauthTrack.responseText.includes('Privacy Verification Required'));
  assert.ok(unauthTrack.responseText.includes('disclosed to the verified purchasing phone number'));
});

test('WhatsApp Cloud Service: rejects WhatsApp chat claims and screenshots as payment verification', () => {
  const service = new WhatsAppCloudService();
  const inventoryEngine = new InventoryStore(SEED_INVENTORIES);

  const paymentClaim = service.processInboundMessage({
    messageId: 'mid-pay-claim',
    fromNumber: '+1 (555) 234-5678',
    customerName: 'Sarah Jenkins',
    textBody: 'I have paid, here is the payment screenshot receipt',
    inventoryEngine,
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });

  assert.ok(paymentClaim.responseText.includes('Payment Verification Notice'));
  assert.ok(paymentClaim.responseText.includes('cannot be verified through WhatsApp messages or screenshots'));
  assert.ok(paymentClaim.responseText.includes('banking and payment gateway clears wire and card transfers independently'));
});

test('WhatsApp Cloud Service: tracks message delivery statuses (SENT -> DELIVERED -> READ)', () => {
  const service = new WhatsAppCloudService({ mode: 'META_TEST' });

  // Add a test message with wamid
  const outbound = service.notifyCustomerOrderDispatched(SEED_ORDERS[0]);
  const wamid = 'wamid.HBgLMTU1NTIzNDU2NzgVAgASGBgyMzA1';
  outbound.wamid = wamid;

  assert.equal(service.getConfig().messageDeliveryActive, false);

  // Meta sends status update: DELIVERED
  const updated = service.updateMessageStatus(wamid, 'DELIVERED');
  assert.equal(updated, true);
  assert.equal(outbound.status, 'DELIVERED');
  assert.equal(service.getConfig().messageDeliveryActive, true);
});
