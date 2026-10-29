import http from 'node:http';
import express, { Request, Response } from 'express';
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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  },
}));

// In-memory backend stores for the full-stack app
const inventoryEngine = new InventoryStore(SEED_INVENTORIES);
const products = [...SEED_PRODUCTS];
const orders: Order[] = [...SEED_ORDERS];
const tenant = SEED_TENANTS[0];

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
const handleInboundWebhook = (req: Request, res: Response) => {
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
      for (const st of statuses) {
        const wamid = st.id;
        const status = st.status?.toUpperCase() as 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
        const errorDetail = st.errors?.[0]?.message || st.errors?.[0]?.title;
        if (wamid && status) {
          whatsappService.updateMessageStatus(wamid, status, errorDetail);
        }
      }
      return res.status(200).json({ status: 'STATUSES_ACKNOWLEDGED', count: statuses.length });
    }

    if (!message) {
      // Return 200 to acknowledge Meta webhook test ping
      return res.status(200).json({ status: 'IGNORED_NO_MESSAGE' });
    }

    const messageId = message.id || `msg-${Date.now()}`;
    const fromNumber = message.from || '+15552345678';
    const customerName = contact?.profile?.name || 'WhatsApp Customer';
    const textBody = message.text?.body || message.button?.text || '';

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

    return res.status(200).json({
      status: 'PROCESSED',
      reply: result.responseText,
      toolUsed: result.toolUsed,
      humanTakeoverActive: result.humanTakeoverActive,
      orderCreatedId: result.orderCreated?.id,
    });
  } catch (err: any) {
    console.error('Webhook processing error:', err);
    return res.status(500).json({ error: err?.message || 'Internal webhook error' });
  }
};

app.post('/api/whatsapp/webhook', handleInboundWebhook);
app.post('/api/webhooks/whatsapp', handleInboundWebhook);

// 3. Configuration Management API (GET & POST)
app.get('/api/whatsapp/config', (_req: Request, res: Response) => {
  const conf = whatsappService.getConfig();
  res.json({
    ...conf,
    webhookCallbackUrl: `${_req.protocol}://${_req.get('host')}/api/whatsapp/webhook`,
  });
});

app.post('/api/whatsapp/config', (req: Request, res: Response) => {
  // Authorization verification: protect owner channel settings from unauthorized access
  const userRole = (req.headers['x-user-role'] as string) || '';
  if (userRole && userRole !== 'BUSINESS_OWNER' && userRole !== 'ADMIN') {
    return res.status(403).json({ error: 'Forbidden: Only Business Owners can modify WhatsApp channel configuration.' });
  }

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
});

// 4. Outbound / Test Message Trigger (POST)
app.post('/api/whatsapp/send', async (req: Request, res: Response) => {
  const { to, message, template } = req.body;
  if (!to || (!message && !template)) {
    return res.status(400).json({ error: 'Missing "to" or "message"/"template" parameter' });
  }

  const result = await whatsappService.dispatchMetaGraphApi(
    to,
    message || '',
    undefined,
    template ? { template } : undefined
  );
  res.json(result);
});

// 5. Message History & Webhook Logs (GET & POST)
app.get('/api/whatsapp/messages', (_req: Request, res: Response) => {
  res.json({
    messages: whatsappService.getMessages(),
  });
});

app.post('/api/whatsapp/messages', (req: Request, res: Response) => {
  const { toNumber, customerName, textBody, orderId } = req.body;
  if (!toNumber || !textBody) {
    return res.status(400).json({ error: 'Missing toNumber or textBody' });
  }
  const msg = whatsappService.sendAgentMessage(toNumber, customerName || 'Customer', textBody, orderId);
  res.json({ success: true, message: msg });
});

app.get('/api/whatsapp/logs', (_req: Request, res: Response) => {
  res.json({
    logs: whatsappService.getWebhookLogs(),
  });
});

// 6. Reset Session
app.post('/api/whatsapp/reset', (req: Request, res: Response) => {
  const { phoneNumber } = req.body;
  if (phoneNumber) {
    whatsappService.resetSession(phoneNumber);
  }
  res.json({ success: true });
});

// 7. Live Meta Graph API Status Check
app.get('/api/whatsapp/status', async (req: Request, res: Response) => {
  const phoneId = req.query.phoneId as string | undefined;
  const result = await whatsappService.fetchPhoneLiveStatus(phoneId);
  res.json(result);
});

// 8. Submit 6-digit SMS verification code to Meta
app.post('/api/whatsapp/verify-code', async (req: Request, res: Response) => {
  const { code, phoneId } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Verification code is required.' });
  }
  const result = await whatsappService.verifyPhoneCode(code, phoneId);
  res.json(result);
});

// 9. Request a new SMS or Voice code from Meta
app.post('/api/whatsapp/request-code', async (req: Request, res: Response) => {
  const { method, language, phoneId } = req.body;
  const result = await whatsappService.requestPhoneCode(method || 'SMS', language || 'en', phoneId);
  res.json(result);
});

// 10. Direct Registration with 6-digit PIN
app.post('/api/whatsapp/register', async (req: Request, res: Response) => {
  const { pin, phoneId } = req.body;
  const result = await whatsappService.registerPhone(pin || '123456', phoneId);
  res.json(result);
});

// 11. Synchronized Central Orders API
app.get('/api/orders', (_req: Request, res: Response) => {
  res.json({ orders });
});

app.post('/api/orders', (req: Request, res: Response) => {
  const newOrder = req.body;
  if (!newOrder || !newOrder.id) {
    return res.status(400).json({ error: 'Invalid order data.' });
  }
  const exists = orders.some((o) => o.id === newOrder.id);
  if (!exists) {
    orders.unshift(newOrder);
  }
  res.json({ success: true, order: newOrder, ordersCount: orders.length });
});

app.put('/api/orders/:id', (req: Request, res: Response) => {
  const id = req.params.id;
  const idx = orders.findIndex((o) => o.id === id);
  if (idx !== -1) {
    orders[idx] = { ...orders[idx], ...req.body, updatedAt: new Date().toISOString() };
    return res.json({ success: true, order: orders[idx] });
  }
  res.status(404).json({ error: 'Order not found' });
});

// 11. Synchronized Inventory & Reservation Store API
app.get('/api/inventory', (_req: Request, res: Response) => {
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
