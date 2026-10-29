import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyWhatsAppWebhook,
  parseWhatsAppInboundPayload,
  buildWhatsAppOutboundPayload,
  handleInboundWhatsAppMessage,
} from './whatsappAdapter.ts';
import { InventoryStore } from './inventoryEngine.ts';
import { SEED_INVENTORIES, SEED_ORDERS, SEED_PRODUCTS, SEED_TENANTS } from './sampleData.ts';

test('WhatsApp Adapter: verifies Meta webhook handshake correctly with valid token', () => {
  const query = {
    'hub.mode': 'subscribe',
    'hub.verify_token': 'my_secure_omni_token_2026',
    'hub.challenge': '1158201948',
  };

  const res = verifyWhatsAppWebhook(query, 'my_secure_omni_token_2026');
  assert.equal(res.verified, true);
  assert.equal(res.challenge, '1158201948');
});

test('WhatsApp Adapter: rejects Meta webhook handshake with invalid token', () => {
  const query = {
    'hub.mode': 'subscribe',
    'hub.verify_token': 'wrong_token',
    'hub.challenge': '1158201948',
  };

  const res = verifyWhatsAppWebhook(query, 'my_secure_omni_token_2026');
  assert.equal(res.verified, false);
  assert.match(res.error || '', /token mismatch/);
});

test('WhatsApp Adapter: extracts inbound text message from Meta webhook payload', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '1555021234', phone_number_id: 'PHONE_ID' },
              contacts: [{ profile: { name: 'Sarah Jenkins' }, wa_id: '15552345678' }],
              messages: [
                {
                  from: '15552345678',
                  id: 'wamid.HBgLMTU1NTIzNDU2NzgVAgASGBgyM0',
                  timestamp: '1729170000',
                  text: { body: 'Do you have TSHIRT001 in stock?' },
                  type: 'text',
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };

  const parsed = parseWhatsAppInboundPayload(payload);
  assert.ok(parsed);
  assert.equal(parsed?.fromPhoneNumber, '15552345678');
  assert.equal(parsed?.contactName, 'Sarah Jenkins');
  assert.equal(parsed?.textBody, 'Do you have TSHIRT001 in stock?');
});

test('WhatsApp Adapter: processes stock inquiry and formats WhatsApp markdown response', () => {
  const inventoryEngine = new InventoryStore(SEED_INVENTORIES);
  const result = handleInboundWhatsAppMessage(
    {
      messageId: 'msg-1',
      fromPhoneNumber: '15552345678',
      contactName: 'Sarah Jenkins',
      timestamp: '1729170000',
      textBody: 'Do you have TSHIRT001 in stock?',
    },
    inventoryEngine,
    SEED_PRODUCTS,
    SEED_ORDERS,
    SEED_TENANTS[0]
  );

  assert.ok(result.responseText.includes('Merino Wool Trail Crewneck T-Shirt'));
  assert.ok(result.responseText.includes('TSHIRT001'));
  assert.equal(result.toolCalled, 'getAvailability("TSHIRT001")');
});

test('WhatsApp Adapter: processes out of stock inquiry for FLASK-VAC-750 (Scenario B)', () => {
  const inventoryEngine = new InventoryStore(SEED_INVENTORIES);
  const result = handleInboundWhatsAppMessage(
    {
      messageId: 'msg-2',
      fromPhoneNumber: '15552345678',
      contactName: 'Sarah Jenkins',
      timestamp: '1729170000',
      textBody: 'Do you have the vacuum trail flask (FLASK-VAC-750)?',
    },
    inventoryEngine,
    SEED_PRODUCTS,
    SEED_ORDERS,
    SEED_TENANTS[0]
  );

  assert.ok(result.responseText.includes('Out of Stock Notification'));
  assert.ok(result.responseText.includes('completely out of stock'));
});
