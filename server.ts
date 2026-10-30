import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express, { Request, Response, type NextFunction, type RequestHandler } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { WhatsAppCloudService } from './src/lib/whatsappCloudService.ts';
import { InventoryStore } from './src/lib/inventoryEngine.ts';
import {
  SEED_INVENTORIES,
  SEED_ORDERS,
  SEED_PRODUCTS,
  SEED_TENANTS,
} from './src/lib/sampleData.ts';
import type { Order } from './src/lib/types.ts';
import {
  authenticateRequest,
  claimWebhookMessage,
  consumeWebChatQuota,
  getRequestUser,
  getTenantOrder,
  getWhatsAppSession,
  listTenantMessages,
  listTenantOrders,
  listTenantUsers,
  releaseWebhookMessage,
  requireRoles,
  saveOrder,
  saveWhatsAppMessages,
  saveWhatsAppSession,
  updateTenantUserRole,
} from './src/lib/firebaseAdmin.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;
const allowedOrigins = new Set(
  (process.env.CORS_ALLOWED_ORIGINS || (process.env.NODE_ENV === 'production'
    ? ''
    : 'http://localhost:3000,http://localhost:5173'))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);

app.use((req: Request, res: Response, next) => {
  const origin = req.header('origin');
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  } else if (origin) {
    return res.status(403).json({ error: 'This frontend origin is not allowed.' });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  },
}));

app.set('trust proxy', 1);

// In-memory backend stores for the full-stack app
const inventoryEngine = new InventoryStore(SEED_INVENTORIES);
const products = [...SEED_PRODUCTS];
const orders: Order[] = [...SEED_ORDERS];
const tenantId = process.env.DEFAULT_TENANT_ID || SEED_TENANTS[0].id;
const tenant = SEED_TENANTS.find((item) => item.id === tenantId) || SEED_TENANTS[0];

app.use('/api', (req: Request, res: Response, next) => {
  const requestPath = req.path.toLowerCase();
  const publicWebhook =
    (requestPath === '/whatsapp/webhook' || requestPath === '/webhooks/whatsapp') &&
    (req.method === 'GET' || req.method === 'POST');
  if (publicWebhook) return next();
  return authenticateRequest(req, res, next);
});

const asyncRoute = (
  handler: (req: Request, res: Response) => Promise<void>
): RequestHandler => (req, res, next) => {
  void handler(req, res).catch(next);
};
const initialToken = process.env.WHATSAPP_ACCESS_TOKEN || '';
const initialAppSecret = process.env.WHATSAPP_APP_SECRET || '';
const initialPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const initialWabaId = process.env.WHATSAPP_WABA_ID || '';
const initialDisplayPhone = process.env.WHATSAPP_DISPLAY_PHONE || 'Meta Developer Sandbox';
const initialVerifyToken = process.env.WHATSAPP_VERIFY_TOKEN || '';
const initialMode = (process.env.WHATSAPP_OPERATING_MODE as any) || 'SIMULATED_DEMO';

const whatsappService = new WhatsAppCloudService(
  {
    mode: initialMode,
    phoneNumberId: initialPhoneNumberId,
    wabaId: initialWabaId,
    displayPhoneNumber: initialDisplayPhone,
    verifyToken: initialVerifyToken,
    authorizedTestRecipient: '',
  },
  initialToken,
  initialAppSecret
);
whatsappService.setMessagePersistenceHandler((message) =>
  saveWhatsAppMessages(tenantId, [message])
);

// 1. Meta WhatsApp Webhook Handshake Verification (GET)
app.get('/api/whatsapp/webhook', (req: Request, res: Response) => {
  const query = req.query as Record<string, string | undefined>;
  const verification = whatsappService.verifyWebhook(query);

  if (verification.verified) {
    // Meta requires the challenge number returned as plain text with HTTP 200
    res.status(200).type('text/plain').send(verification.challenge);
  } else {
    res.status(403).json({ error: verification.error || 'Verification failed' });
  }
});

// Alias for backwards-compatibility
app.get('/api/webhooks/whatsapp', (req: Request, res: Response) => {
  const query = req.query as Record<string, string | undefined>;
  const verification = whatsappService.verifyWebhook(query);
  if (verification.verified) {
    res.status(200).type('text/plain').send(verification.challenge);
  } else {
    res.status(403).json({ error: verification.error || 'Verification failed' });
  }
});

// 2. Meta WhatsApp Inbound Webhook Event Receiver (POST)
const handleInboundWebhook = async (req: Request, res: Response) => {
  console.info('[Meta Webhook] POST received.');
  let claimedMessageId: string | undefined;
  try {
    // Verify HMAC-SHA256 signatures for every webhook mode.
    const sigHeader = req.headers['x-hub-signature-256'] as string | undefined;
    const sigVerification = whatsappService.verifySignature((req as any).rawBody, sigHeader);
    if (!sigVerification.valid) {
      console.warn(`[Meta Webhook] Signature verification failed: ${sigVerification.reason}`);
      return res.status(401).json({ error: `Unauthorized: ${sigVerification.reason}` });
    }

    const payload = req.body;
    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    const contact = change?.contacts?.[0];

    // Handle delivery status update events (e.g. delivered, read, failed)
    const statuses = change?.statuses;
    if (Array.isArray(statuses) && statuses.length > 0) {
      const persistedMessages = await listTenantMessages(tenantId);
      let messagesChanged = false;
      for (const st of statuses) {
        const wamid = st.id;
        const status = st.status?.toUpperCase() as 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
        const errorDetail = st.errors?.[0]?.message || st.errors?.[0]?.title;
        if (wamid && status) {
          whatsappService.updateMessageStatus(wamid, status, errorDetail);
          const persisted = persistedMessages.find((item) => item.wamid === wamid);
          if (persisted) {
            persisted.status = status;
            if (errorDetail) persisted.errorMessage = errorDetail;
            messagesChanged = true;
          }
        }
      }
      if (messagesChanged) await saveWhatsAppMessages(tenantId, persistedMessages);
      console.info(`[Meta Webhook] Acknowledged ${statuses.length} message status update(s).`);
      return res.status(200).json({ status: 'STATUSES_ACKNOWLEDGED', count: statuses.length });
    }

    if (!message) {
      // Return 200 to acknowledge Meta webhook test ping
      console.info('[Meta Webhook] Signed event contained no message or status update.');
      return res.status(200).json({ status: 'IGNORED_NO_MESSAGE' });
    }

    const messageId = message.id;
    if (!messageId) {
      return res.status(400).json({ error: 'Webhook message is missing its Meta message ID.' });
    }
    if (!await claimWebhookMessage(messageId)) {
      return res.status(200).json({ status: 'DUPLICATE_IGNORED' });
    }
    claimedMessageId = messageId;

    const fromNumber = message.from || '+15552345678';
    const customerName = contact?.profile?.name || 'WhatsApp Customer';
    const textBody = message.text?.body || message.button?.text || '';
    const [persistedSession, persistedOrders] = await Promise.all([
      getWhatsAppSession(fromNumber, tenantId),
      listTenantOrders(tenantId),
    ]);
    if (persistedSession) whatsappService.restoreSession(persistedSession);
    orders.splice(0, orders.length, ...persistedOrders);

    const result = whatsappService.processInboundMessage({
      messageId,
      fromNumber,
      customerName,
      textBody,
      inventoryEngine,
      products,
      orders,
      tenant,
      onOrderCreated: (newOrder) => {
        orders.unshift(newOrder);
      },
    });
    const session = whatsappService.getSession(fromNumber, customerName);
    await Promise.all([
      saveWhatsAppMessages(tenantId, whatsappService.getMessages()),
      saveWhatsAppSession(session, tenantId),
      ...(result.orderCreated ? [saveOrder(result.orderCreated)] : []),
    ]);
    claimedMessageId = undefined;

    console.info('[Meta Webhook] Inbound message processed.');
    return res.status(200).json({
      status: 'PROCESSED',
      reply: result.responseText,
      toolUsed: result.toolUsed,
      humanTakeoverActive: result.humanTakeoverActive,
      orderCreatedId: result.orderCreated?.id,
    });
  } catch (err: unknown) {
    if (claimedMessageId) {
      try {
        await releaseWebhookMessage(claimedMessageId);
      } catch (releaseError) {
        console.error('[Meta Webhook] Could not release failed event idempotency record.', releaseError);
      }
    }
    console.error('Webhook processing error:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Internal webhook error',
    });
  }
};

app.post('/api/whatsapp/webhook', handleInboundWebhook);
app.post('/api/webhooks/whatsapp', handleInboundWebhook);

app.post(
  '/api/web-chat',
  requireRoles(
    'SUPER_ADMIN',
    'BUSINESS_OWNER',
    'SALES_STAFF',
    'FULFILLMENT_STAFF',
    'SUPPORT_STAFF',
    'CUSTOMER'
  ),
  asyncRoute(async (req, res) => {
    const user = getRequestUser(req);
    if (!await consumeWebChatQuota(user.id, user.tenantId)) {
      res.status(429).json({ error: 'Chat message limit reached. Wait a minute before trying again.' });
      return;
    }

    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const textBody = typeof req.body?.text === 'string'
      ? req.body.text
      : message?.text?.body || message?.button?.text;
    if (typeof textBody !== 'string' || !textBody.trim() || textBody.length > 2000) {
      res.status(400).json({ error: 'Enter a message between 1 and 2,000 characters.' });
      return;
    }

    const fromNumber = `web-${user.id}`;
    const messageId = `web-${randomUUID()}`;
    const [persistedSession, persistedOrders] = await Promise.all([
      getWhatsAppSession(fromNumber, user.tenantId),
      listTenantOrders(user.tenantId),
    ]);
    if (persistedSession) whatsappService.restoreSession(persistedSession);
    orders.splice(0, orders.length, ...persistedOrders);

    const result = whatsappService.processWebChatMessage({
      messageId,
      fromNumber,
      customerName: user.name,
      textBody: textBody.trim(),
      inventoryEngine,
      products,
      orders,
      tenant,
    });
    const session = whatsappService.getSession(fromNumber, user.name);
    await Promise.all([
      saveWhatsAppMessages(user.tenantId, whatsappService.getMessages()),
      saveWhatsAppSession(session, user.tenantId),
    ]);
    res.json({
      status: 'PROCESSED',
      reply: result.responseText,
      toolUsed: result.toolUsed,
      fromNumber,
    });
  })
);

app.get('/health', (_req: Request, res: Response) => {
  const config = whatsappService.getConfig();
  res.status(200).json({
    status: 'ok',
    whatsapp: {
      mode: config.mode,
      verifyTokenConfigured: Boolean(process.env.WHATSAPP_VERIFY_TOKEN),
      appSecretConfigured: Boolean(config.hasAppSecret),
      accessTokenConfigured: Boolean(config.hasAccessToken),
      phoneNumberIdConfigured: Boolean(config.phoneNumberId),
      replyConfigurationComplete: config.mode !== 'SIMULATED_DEMO' &&
        Boolean(config.hasAccessToken) &&
        Boolean(config.phoneNumberId),
    },
    authentication: {
      projectConfigured: Boolean(
        process.env.FIREBASE_PROJECT_ID ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GCLOUD_PROJECT
      ),
      ownerEmailConfigured: Boolean(process.env.OWNER_EMAIL),
      allowedFrontendOriginsConfigured: allowedOrigins.size > 0,
    },
  });
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  res.json({ user: getRequestUser(req) });
});

app.get(
  '/api/users',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN'),
  asyncRoute(async (req, res) => {
    const user = getRequestUser(req);
    res.json({ users: await listTenantUsers(user.tenantId) });
  })
);

app.put(
  '/api/users/:id/role',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN'),
  asyncRoute(async (req, res) => {
    const actor = getRequestUser(req);
    const role = req.body?.role;
    const assignableRoles = ['CUSTOMER', 'SALES_STAFF', 'FULFILLMENT_STAFF', 'SUPPORT_STAFF'];
    if (!assignableRoles.includes(role)) {
      res.status(400).json({ error: 'Choose a customer or staff role. Owner roles are assigned outside the app.' });
      return;
    }

    try {
      const user = await updateTenantUserRole(
        actor.tenantId,
        actor.id,
        req.params.id,
        role
      );
      if (!user) {
        res.status(404).json({ error: 'Team member not found in your business.' });
        return;
      }
      res.json({ success: true, user });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'The role update was rejected.',
      });
    }
  })
);

// 3. Configuration Management API (GET & POST)
app.get('/api/whatsapp/config', (req: Request, res: Response) => {
  const user = getRequestUser(req);
  const conf = whatsappService.getConfig();
  if (user.role === 'BUSINESS_OWNER' || user.role === 'SUPER_ADMIN') {
    return res.json({
      ...conf,
      tenantId: user.tenantId,
      webhookCallbackUrl: `${req.protocol}://${req.get('host')}/api/whatsapp/webhook`,
    });
  }
  return res.json({
    mode: conf.mode,
    displayPhoneNumber: conf.displayPhoneNumber,
  });
});

app.post(
  '/api/whatsapp/config',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN'),
  (req: Request, res: Response) => {
  const {
    mode,
    wabaId,
    phoneNumberId,
    displayPhoneNumber,
    verifyToken,
    accessToken,
    appSecret,
    graphApiVersion,
    authorizedTestRecipient,
    autoAiReplies,
    aiBusinessPrompt,
  } = req.body;

  // Input validation
  const validModes = ['DEVELOPER_SANDBOX', 'CLIENT_BUSINESS_LIVE', 'SIMULATED_DEMO', 'META_TEST', 'LIVE_PRODUCTION'];
  if (mode && !validModes.includes(mode)) {
    return res.status(400).json({ error: `Invalid mode. Must be one of: ${validModes.join(', ')}` });
  }
  if (phoneNumberId && /\D/.test(phoneNumberId.trim())) {
    return res.status(400).json({ error: 'Phone Number ID must contain only digits.' });
  }
  if (wabaId && /\D/.test(wabaId.trim())) {
    return res.status(400).json({ error: 'WABA ID must contain only digits.' });
  }

  const updated = whatsappService.updateConfig(
    {
      mode,
      wabaId: wabaId ? wabaId.trim() : undefined,
      phoneNumberId: phoneNumberId ? phoneNumberId.trim() : undefined,
      displayPhoneNumber: displayPhoneNumber ? displayPhoneNumber.trim() : undefined,
      verifyToken: verifyToken ? verifyToken.trim() : undefined,
      graphApiVersion: graphApiVersion ? graphApiVersion.trim() : undefined,
      authorizedTestRecipient: authorizedTestRecipient ? authorizedTestRecipient.trim() : undefined,
      autoAiReplies,
      aiBusinessPrompt,
    },
    accessToken,
    appSecret
  );
  res.json({ success: true, config: updated });
  }
);

// 4. Outbound / Test Message Trigger (POST)
app.post(
  '/api/whatsapp/send',
  requireRoles('BUSINESS_OWNER', 'SUPPORT_STAFF'),
  asyncRoute(async (req, res) => {
  const { to, message, template } = req.body;
  if (!to || (!message && !template)) {
    res.status(400).json({ error: 'Missing "to" or "message"/"template" parameter' });
    return;
  }

  const result = await whatsappService.dispatchMetaGraphApi(
    to,
    message || '',
    undefined,
    template ? { template } : undefined
  );
  res.json(result);
  })
);

// 5. Message History & Webhook Logs (GET & POST)
app.get(
  '/api/whatsapp/messages',
  requireRoles('BUSINESS_OWNER', 'SUPPORT_STAFF'),
  asyncRoute(async (req, res) => {
    const user = getRequestUser(req);
    res.json({ messages: await listTenantMessages(user.tenantId) });
  })
);

app.post(
  '/api/whatsapp/messages',
  requireRoles('BUSINESS_OWNER', 'SUPPORT_STAFF'),
  asyncRoute(async (req, res) => {
  const { toNumber, customerName, textBody, orderId } = req.body;
  if (!toNumber || !textBody) {
    res.status(400).json({ error: 'Missing toNumber or textBody' });
    return;
  }
  const msg = whatsappService.sendAgentMessage(toNumber, customerName || 'Customer', textBody, orderId);
  const user = getRequestUser(req);
  await saveWhatsAppMessages(user.tenantId, [msg]);
  res.json({ success: true, message: msg });
  })
);

app.get(
  '/api/whatsapp/logs',
  requireRoles('BUSINESS_OWNER', 'SUPPORT_STAFF'),
  (_req: Request, res: Response) => {
  res.json({
    logs: whatsappService.getWebhookLogs(),
  });
  }
);

// 6. Reset Session
app.post(
  '/api/whatsapp/reset',
  requireRoles('BUSINESS_OWNER', 'SUPPORT_STAFF'),
  (req: Request, res: Response) => {
  const { phoneNumber } = req.body;
  if (phoneNumber) {
    whatsappService.resetSession(phoneNumber);
  }
  res.json({ success: true });
  }
);

// 7. Live Meta Graph API Status Check
app.get(
  '/api/whatsapp/status',
  requireRoles('BUSINESS_OWNER'),
  asyncRoute(async (req, res) => {
  const phoneId = req.query.phoneId as string | undefined;
  const result = await whatsappService.fetchPhoneLiveStatus(phoneId);
  res.json(result);
  })
);

// 8. Submit 6-digit SMS verification code to Meta
app.post(
  '/api/whatsapp/verify-code',
  requireRoles('BUSINESS_OWNER'),
  asyncRoute(async (req, res) => {
  const { code, phoneId } = req.body;
  if (!code) {
    res.status(400).json({ error: 'Verification code is required.' });
    return;
  }
  const result = await whatsappService.verifyPhoneCode(code, phoneId);
  res.json(result);
  })
);

// 9. Request a new SMS or Voice code from Meta
app.post(
  '/api/whatsapp/request-code',
  requireRoles('BUSINESS_OWNER'),
  asyncRoute(async (req, res) => {
  const { method, language, phoneId } = req.body;
  const result = await whatsappService.requestPhoneCode(method || 'SMS', language || 'en', phoneId);
  res.json(result);
  })
);

// 10. Direct Registration with 6-digit PIN
app.post(
  '/api/whatsapp/register',
  requireRoles('BUSINESS_OWNER'),
  asyncRoute(async (req, res) => {
  const { pin, phoneId } = req.body;
  const result = await whatsappService.registerPhone(pin || '123456', phoneId);
  res.json(result);
  })
);

// 11. Synchronized Central Orders API
app.get(
  '/api/orders',
  asyncRoute(async (req, res) => {
    const user = getRequestUser(req);
    const tenantOrders = await listTenantOrders(user.tenantId);
    const visibleOrders = user.role === 'CUSTOMER'
      ? tenantOrders.filter((order) => order.customerId === user.id)
      : tenantOrders;
    res.json({ orders: visibleOrders });
  })
);

app.post(
  '/api/orders',
  asyncRoute(async (req, res) => {
    const user = getRequestUser(req);
    const submittedOrder = req.body as Order | undefined;
    if (!submittedOrder?.id || !Array.isArray(submittedOrder.items)) {
      res.status(400).json({ error: 'Invalid order data.' });
      return;
    }
    const newOrder: Order = {
      ...submittedOrder,
      tenantId: user.tenantId,
      customerId: user.role === 'CUSTOMER' ? user.id : submittedOrder.customerId,
      customerEmail: user.role === 'CUSTOMER' ? user.email : submittedOrder.customerEmail,
      customerName: user.role === 'CUSTOMER' ? user.name : submittedOrder.customerName,
      updatedAt: new Date().toISOString(),
    };
    await saveOrder(newOrder);
    const existingIndex = orders.findIndex((order) => order.id === newOrder.id);
    if (existingIndex >= 0) orders[existingIndex] = newOrder;
    else orders.unshift(newOrder);
    const tenantOrders = await listTenantOrders(user.tenantId);
    res.json({ success: true, order: newOrder, ordersCount: tenantOrders.length });
  })
);

app.put(
  '/api/orders/:id',
  requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN', 'SALES_STAFF', 'FULFILLMENT_STAFF', 'SUPPORT_STAFF'),
  asyncRoute(async (req, res) => {
    const user = getRequestUser(req);
    const currentOrder = await getTenantOrder(user.tenantId, req.params.id);
    if (!currentOrder) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }
    const updatedOrder: Order = {
      ...currentOrder,
      ...req.body,
      id: currentOrder.id,
      tenantId: currentOrder.tenantId,
      customerId: currentOrder.customerId,
      updatedAt: new Date().toISOString(),
    };
    await saveOrder(updatedOrder);
    const index = orders.findIndex((order) => order.id === updatedOrder.id);
    if (index >= 0) orders[index] = updatedOrder;
    res.json({ success: true, order: updatedOrder });
  })
);

// 11. Synchronized Inventory & Reservation Store API
app.get('/api/inventory', requireRoles('BUSINESS_OWNER', 'SUPER_ADMIN', 'FULFILLMENT_STAFF', 'SUPPORT_STAFF'), (_req: Request, res: Response) => {
  res.json({
    inventories: inventoryEngine.getAllInventories(),
    reservations: inventoryEngine.getAllReservations(),
  });
});

// Meta App Publishing Compliance: Privacy Policy & Terms of Service endpoints
app.get('/privacy', (_req: Request, res: Response) => {
  res.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy - SokoFlow</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 780px; margin: 40px auto; padding: 0 24px; line-height: 1.6; color: #1e293b; background: #f8fafc; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 16px; padding: 36px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    h1 { color: #0f172a; margin-top: 0; font-size: 26px; }
    h2 { color: #334155; font-size: 18px; margin-top: 24px; }
    p, li { color: #475569; font-size: 14px; }
    .badge { display: inline-block; background: #ecfdf5; color: #047857; font-weight: 600; font-size: 11px; padding: 4px 10px; border-radius: 999px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">Official Policy</span>
    <h1>Privacy Policy - SokoFlow</h1>
    <p><em>Last updated: October 2026</em></p>
    <p>SokoFlow ("we", "our", or "us") operates a commerce operations platform, including automated conversational commerce via Meta WhatsApp Business Cloud API.</p>
    <h2>1. Information We Collect</h2>
    <p>When you interact with our WhatsApp messaging bot or storefront, we collect and process your WhatsApp phone number, display profile name, and incoming message text strictly to fulfill your inquiries, check inventory, and manage order deliveries.</p>
    <h2>2. Purpose of Processing</h2>
    <ul>
      <li>Answering product, pricing, and stock availability questions in real time.</li>
      <li>Creating and tracking customer order reservations.</li>
      <li>Sending transactional dispatch and shipping status notifications.</li>
    </ul>
    <h2>3. Data Protection & Sharing</h2>
    <p>We do not sell, rent, or trade your personal data. All messaging data transferred through Meta WhatsApp Cloud API is encrypted in transit under Meta's Cloud API security standards.</p>
    <h2>4. Data Deletion Requests</h2>
    <p>You may request full deletion of your customer record and messaging history at any time by contacting our Data Protection Officer at <strong>nyakegojohn36@gmail.com</strong>.</p>
  </div>
</body>
</html>`);
});

app.get('/terms', (_req: Request, res: Response) => {
  res.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Service - SokoFlow</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 780px; margin: 40px auto; padding: 0 24px; line-height: 1.6; color: #1e293b; background: #f8fafc; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 16px; padding: 36px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    h1 { color: #0f172a; margin-top: 0; font-size: 26px; }
    p { color: #475569; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Terms of Service - SokoFlow</h1>
    <p><em>Last updated: October 2026</em></p>
    <p>By using the SokoFlow platform and its WhatsApp Business automation service, you agree to receive automated transactional updates for your ecommerce purchases and inquiries.</p>
    <p>For inquiries, contact: <strong>nyakegojohn36@gmail.com</strong>.</p>
  </div>
</body>
</html>`);
});

app.use((error: Error, _req: Request, res: Response, next: NextFunction) => {
  console.error('[API] Request failed.', error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'An unexpected server error occurred.' });
});

// 7. Mount Vite dev server middleware or serve dist in production
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
        hmr: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[SokoFlow] Running on http://0.0.0.0:${PORT}`);
  });
}

function handleShutdown(signal: string) {
  console.log(`[SokoFlow] Received ${signal}, closing gracefully...`);
  httpServer.close(() => {
    console.log('[SokoFlow] HTTP server closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

startServer().catch((err) => {
  console.error('[SokoFlow] Startup error:', err);
  process.exit(1);
});
