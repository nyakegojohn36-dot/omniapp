import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { WhatsAppCloudService } from './whatsappCloudService.ts';
import { InMemoryCommerceState, createConversationStockPort } from './commerceState.ts';
import type { ConversationStockPort } from './commerceState.ts';
import { SEED_INVENTORIES, SEED_ORDERS, SEED_PRODUCTS, SEED_TENANTS } from './sampleData.ts';
import type { Order } from './types.ts';

/**
 * Mirrors the server wiring: a fresh availability snapshot per inbound message,
 * reservations always delegated to the authoritative store.
 */
function warehouse(tenantId: string = SEED_TENANTS[0].id) {
  const state = new InMemoryCommerceState({
    tenantId,
    inventory: SEED_INVENTORIES,
    products: SEED_PRODUCTS,
  });
  const stock = async (): Promise<ConversationStockPort> =>
    createConversationStockPort({
      tenantId,
      rows: await state.listInventory(tenantId),
      reserve: (tenant, command) => state.reserve(tenant, command),
    });
  return { state, tenantId, stock };
}

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

test('WhatsApp Cloud Service: completes full multi-step order placement journey via WhatsApp', async () => {
  const { state, tenantId, stock } = warehouse();
  const products = [...SEED_PRODUCTS];
  const orders: Order[] = [...SEED_ORDERS];
  let createdOrder: Order | null = null;

  const service = new WhatsAppCloudService();
  const phone = '+1 (555) 987-6543';
  const name = 'David Miller';

  // Step 1: Customer asks to buy TSHIRT001
  const step1 = await service.processInboundMessage({
    messageId: 'mid-step-1',
    fromNumber: phone,
    customerName: name,
    textBody: 'Hi, I want to buy 2 pairs of TSHIRT001',
    stock: await stock(),
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
  const step2 = await service.processInboundMessage({
    messageId: 'mid-step-2',
    fromNumber: phone,
    customerName: name,
    textBody: '450 Pine Road, Portland, 97201',
    stock: await stock(),
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
  const stockBefore = (await state.getAvailability(tenantId, 'TSHIRT001'));

  // Step 3: Customer confirms with "YES"
  const step3 = await service.processInboundMessage({
    messageId: 'mid-step-3',
    fromNumber: phone,
    customerName: name,
    textBody: 'YES',
    stock: await stock(),
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
  const stockAfter = (await state.getAvailability(tenantId, 'TSHIRT001'));
  assert.equal(stockAfter.availableStock, stockBefore.availableStock - 2);
  assert.ok(ord.reservationId);
});

test('Authenticated web chat never sends Meta messages or creates WhatsApp orders', async () => {
  const service = new WhatsAppCloudService({
    mode: 'LIVE_PRODUCTION',
    phoneNumberId: 'test-phone-id',
  });
  const { state, stock } = warehouse();
  const orders = [...SEED_ORDERS];
  const originalOrderCount = orders.length;
  const params = {
    fromNumber: 'web-user-123',
    customerName: 'Test User',
    stock: await stock(),
    products: SEED_PRODUCTS,
    orders,
    tenant: SEED_TENANTS[0],
  };

  await service.processWebChatMessage({
    ...params,
    messageId: 'web-step-1',
    textBody: 'I want to buy 2 TSHIRT001',
  });
  await service.processWebChatMessage({
    ...params,
    messageId: 'web-step-2',
    textBody: '450 Pine Road, Portland, 97201',
  });
  const confirmation = await service.processWebChatMessage({
    ...params,
    messageId: 'web-step-3',
    textBody: 'YES',
  });

  assert.match(confirmation.responseText, /secure checkout/i);
  assert.equal(orders.length, originalOrderCount);
  assert.equal(service.getConfig().mode, 'LIVE_PRODUCTION');
  assert.ok(service.getMessages().every((message) => message.sourceMode === 'SIMULATED_DEMO'));
});

test('Request-local web chat isolates matching sender IDs across tenants and from provider messages', async () => {
  const provider = new WhatsAppCloudService({ mode: 'LIVE_PRODUCTION', phoneNumberId: 'test-provider' });
  const first = new WhatsAppCloudService();
  const second = new WhatsAppCloudService();
  const { stock } = warehouse();
  const sender = 'web-shared-account-id';
  const message = {
    fromNumber: sender, customerName: 'Web Customer', stock: await stock(),
    products: SEED_PRODUCTS, orders: [...SEED_ORDERS],
  };
  await first.processWebChatMessage({ ...message, tenant: SEED_TENANTS[0],
    messageId: 'web-tenant-a', textBody: 'I want to buy 2 TSHIRT001' });
  const saved = first.getSession(sender, message.customerName);
  const restored = new WhatsAppCloudService();
  restored.restoreSession(saved);
  assert.deepEqual(restored.getSession(sender, message.customerName), saved);
  assert.notDeepEqual(second.getSession(sender, message.customerName), saved);
  assert.equal(provider.getMessages().length, 0);

  await second.processWebChatMessage({ ...message, tenant: { ...SEED_TENANTS[0], id: 'tenant-web-b' },
    messageId: 'web-tenant-b', textBody: 'Hello from another workspace' });
  assert.ok(first.getMessages().some((record) => record.textBody === 'I want to buy 2 TSHIRT001'));
  assert.ok(second.getMessages().some((record) => record.textBody === 'Hello from another workspace'));
  assert.equal(first.getMessages().some((record) => record.textBody === 'Hello from another workspace'), false);
  assert.equal(second.getMessages().some((record) => record.textBody === 'I want to buy 2 TSHIRT001'), false);
  assert.equal(provider.getMessages().length, 0);
  assert.equal(first.getConfig().hasAccessToken, false);
  assert.equal(second.getConfig().hasAccessToken, false);
});

test('WhatsApp Cloud Service: refuses to order out-of-stock item and suggests alternatives', async () => {
  const { state, stock } = warehouse();
  const service = new WhatsAppCloudService();

  const res = await service.processInboundMessage({
    messageId: 'mid-oos-1',
    fromNumber: '+1 (555) 777-8888',
    customerName: 'Alex Test',
    textBody: 'I want to order FLASK-VAC-750',
    stock: await stock(),
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });

  assert.ok(res.responseText.includes('Out of Stock'));
  assert.ok(res.responseText.includes('TSHIRT001'));
});

test('WhatsApp Cloud Service: enforces idempotency on duplicate webhook message IDs', async () => {
  const { state, stock } = warehouse();
  const service = new WhatsAppCloudService();

  const first = await service.processInboundMessage({
    messageId: 'wamid-dup-test-01',
    fromNumber: '+1 (555) 111-2222',
    customerName: 'First Run',
    textBody: 'Do you have TSHIRT001 in stock?',
    stock: await stock(),
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });
  assert.ok(first.responseText.includes('Merino Wool Trail Crewneck T-Shirt'));

  const second = await service.processInboundMessage({
    messageId: 'wamid-dup-test-01', // duplicate ID!
    fromNumber: '+1 (555) 111-2222',
    customerName: 'First Run',
    textBody: 'Do you have TSHIRT001 in stock?',
    stock: await stock(),
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });
  assert.equal(second.responseText, 'This request was already processed.');
});

test('WhatsApp Cloud Service: pauses AI replies during human support takeover', async () => {
  const { state, stock } = warehouse();
  const service = new WhatsAppCloudService();
  const phone = '+1 (555) 444-5555';

  // Customer asks for human
  const escalation = await service.processInboundMessage({
    messageId: 'wamid-human-1',
    fromNumber: phone,
    customerName: 'Emma Watson',
    textBody: 'I want to speak with an agent',
    stock: await stock(),
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });

  assert.equal(escalation.humanTakeoverActive, true);
  assert.ok(escalation.responseText.includes('connected to our human support team'));

  // Subsequent message from customer should have AI paused
  const followup = await service.processInboundMessage({
    messageId: 'wamid-human-2',
    fromNumber: phone,
    customerName: 'Emma Watson',
    textBody: 'My item arrived broken',
    stock: await stock(),
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });

  assert.equal(followup.humanTakeoverActive, true);
  assert.ok(followup.responseText.includes('Automated replies paused'));

  // Return to AI
  const resume = await service.processInboundMessage({
    messageId: 'wamid-human-3',
    fromNumber: phone,
    customerName: 'Emma Watson',
    textBody: 'RETURN TO AI',
    stock: await stock(),
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

test('WhatsApp Cloud Service: strictly enforces customer privacy when tracking orders', async () => {
  const service = new WhatsAppCloudService();
  const { state, tenantId, stock } = warehouse();

  // Sarah Nekesa (phone +254 752 720933) tracks her own order ORD-000008
  const authTrack = await service.processInboundMessage({
    messageId: 'mid-track-auth',
    fromNumber: '+254 752 720933',
    customerName: 'Sarah Nekesa',
    textBody: 'TRACK ORD-000008',
    stock: await stock(),
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });
  assert.ok(authTrack.responseText.includes('ORD-000008'));
  assert.ok(authTrack.responseText.includes('Sarah Nekesa') || authTrack.responseText.includes('Safari Peak'));

  // Unauthorized stranger (+1 (555) 999-4321) tries to snoop on ORD-000008
  const unauthTrack = await service.processInboundMessage({
    messageId: 'mid-track-unauth',
    fromNumber: '+1 (555) 999-4321',
    customerName: 'Stranger',
    textBody: 'TRACK ORD-000008',
    stock: await stock(),
    products: SEED_PRODUCTS,
    orders: SEED_ORDERS,
    tenant: SEED_TENANTS[0],
  });
  assert.ok(unauthTrack.responseText.includes('Privacy Verification Required'));
  assert.ok(unauthTrack.responseText.includes('disclosed to the verified purchasing phone number'));
});

test('WhatsApp Cloud Service: rejects WhatsApp chat claims and screenshots as payment verification', async () => {
  const service = new WhatsAppCloudService();
  const { state, stock } = warehouse();

  const paymentClaim = await service.processInboundMessage({
    messageId: 'mid-pay-claim',
    fromNumber: '+1 (555) 234-5678',
    customerName: 'Sarah Jenkins',
    textBody: 'I have paid, here is the payment screenshot receipt',
    stock: await stock(),
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
