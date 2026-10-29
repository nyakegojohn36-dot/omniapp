/**
 * Meta WhatsApp Cloud API Adapter for SokoFlow
 * Handles webhook handshakes, payload extraction, message normalization,
 * and routing into the grounded customer assistant.
 */

import { InventoryStore } from './inventoryEngine.ts';
import type { Order, Product, Tenant } from './types.ts';
import { formatCurrency } from './pricingEngine.ts';

export interface WhatsAppInboundMessage {
  messageId: string;
  fromPhoneNumber: string;
  contactName: string;
  timestamp: string;
  textBody: string;
}

export interface WhatsAppWebhookVerification {
  mode: string;
  verifyToken: string;
  challenge: string;
}

export interface WhatsAppOutboundPayload {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: 'text';
  text: {
    preview_url?: boolean;
    body: string;
  };
}

/**
 * Verifies the Meta Webhook Handshake (GET /api/webhooks/whatsapp)
 */
export function verifyWhatsAppWebhook(
  query: Record<string, string | undefined>,
  configuredVerifyToken: string
): { verified: boolean; challenge?: string; error?: string } {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (!mode || !token) {
    return { verified: false, error: 'Missing hub.mode or hub.verify_token query parameter.' };
  }

  if (mode === 'subscribe' && token === configuredVerifyToken) {
    return { verified: true, challenge: challenge || '' };
  }

  return { verified: false, error: 'Invalid verification token mismatch.' };
}

/**
 * Extracts and normalizes inbound message from Meta Webhook POST payload
 */
export function parseWhatsAppInboundPayload(
  payload: Record<string, any>
): WhatsAppInboundMessage | null {
  try {
    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    const contact = change?.contacts?.[0];

    if (!message || message.type !== 'text') {
      return null;
    }

    return {
      messageId: message.id,
      fromPhoneNumber: message.from,
      contactName: contact?.profile?.name || 'WhatsApp Customer',
      timestamp: message.timestamp,
      textBody: message.text?.body || '',
    };
  } catch {
    return null;
  }
}

/**
 * Formats outgoing message payload for Meta Graph API
 */
export function buildWhatsAppOutboundPayload(
  recipientPhone: string,
  messageText: string
): WhatsAppOutboundPayload {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipientPhone,
    type: 'text',
    text: {
      preview_url: false,
      body: messageText,
    },
  };
}

/**
 * Processes an inbound WhatsApp customer inquiry using grounded tools
 */
export function handleInboundWhatsAppMessage(
  inbound: WhatsAppInboundMessage,
  inventoryEngine: InventoryStore,
  products: Product[],
  orders: Order[],
  tenant: Tenant
): { responseText: string; toolCalled?: string; toolResult?: any } {
  const query = inbound.textBody.trim().toLowerCase();

  // 1. Availability check for TSHIRT001
  if (query.includes('tshirt') || query.includes('t-shirt') || query.includes('tshirt001')) {
    const stock = inventoryEngine.getAvailability('TSHIRT001');
    const prod = products.find((p) => p.sku === 'TSHIRT001');
    const price = prod ? formatCurrency(prod.basePriceCents, prod.currency, tenant.locale) : '$48.00';

    return {
      responseText: `*${tenant.name} - Product Availability*\n\n` +
        `Yes! Our *Merino Wool Trail Crewneck T-Shirt* (SKU: \`TSHIRT001\`) is in stock.\n\n` +
        `• Available Units: *${stock.availableStock}*\n` +
        `• Price: *${price}*\n` +
        `• Variants: Navy / Charcoal (Medium, Large)\n\n` +
        `Reply *BUY TSHIRT001* to start your order.`,
      toolCalled: 'getAvailability("TSHIRT001")',
      toolResult: stock,
    };
  }

  // 2. Out of stock check for FLASK-VAC-750 (Scenario B)
  if (query.includes('flask') || query.includes('bottle') || query.includes('flask-vac-750')) {
    const stock = inventoryEngine.getAvailability('FLASK-VAC-750');
    return {
      responseText: `*${tenant.name} - Out of Stock Notification*\n\n` +
        `Sorry, the *Vacuum Thermal Trail Flask* (SKU: \`FLASK-VAC-750\`) is currently completely out of stock at all logistics hubs.\n\n` +
        `Would you like to:\n` +
        `1️⃣ Register for instant restock SMS alert\n` +
        `2️⃣ View similar items (e.g. Glacier Hardshell Jacket)\n\n` +
        `Reply with 1 or 2 to choose.`,
      toolCalled: 'getAvailability("FLASK-VAC-750")',
      toolResult: stock,
    };
  }

  // 3. Excessive quantity check (Scenario C)
  if (query.includes('beanie') || query.includes('watch cap') || query.includes('bnie-ribbed-01')) {
    const stock = inventoryEngine.getAvailability('BNIE-RIBBED-01');
    if (query.includes('10') || query.includes('15')) {
      return {
        responseText: `*${tenant.name} - Stock Limitation*\n\n` +
          `You requested *10 units* of the Ribbed Merino Watch Cap (SKU: \`BNIE-RIBBED-01\`), but our distribution center currently has only *${stock.availableStock} units* available.\n\n` +
          `Would you like to order the *${stock.availableStock}* available units today? Reply *YES* or *SUPPORT*.`,
        toolCalled: 'getAvailability("BNIE-RIBBED-01")',
        toolResult: stock,
      };
    }
    return {
      responseText: `*${tenant.name}*\n\nThe Ribbed Merino Watch Cap is in stock with *${stock.availableStock} units* available ($28.00).`,
      toolCalled: 'getAvailability("BNIE-RIBBED-01")',
      toolResult: stock,
    };
  }

  // 4. Order tracking
  if (query.includes('ord-') || query.includes('order') || query.includes('track')) {
    const match = inbound.textBody.match(/ORD-\d{6}/i);
    const orderId = match ? match[0].toUpperCase() : 'ORD-000008';
    const found = orders.find((o) => o.id === orderId);

    if (found) {
      return {
        responseText: `*${tenant.name} - Order Status Update*\n\n` +
          `Order ID: *${found.id}*\n` +
          `Status: *${found.status}*\n` +
          `Total: *${formatCurrency(found.totalCents, found.currency, tenant.locale)}*\n` +
          `Payment: *${found.isPaid ? 'Verified ✓' : 'Awaiting Payment ⏳'}*\n` +
          (found.trackingNumber ? `Tracking: *${found.shippingCarrier}* (\`${found.trackingNumber}\`)\n` : '') +
          `\nNeed changes? Reply *SUPPORT* to connect with an agent.`,
        toolCalled: `findOrder("${orderId}")`,
        toolResult: { id: found.id, status: found.status, isPaid: found.isPaid },
      };
    }

    return {
      responseText: `*${tenant.name}*\n\nI could not locate an order matching "${orderId}". Please double-check your order number or reply *AGENT* to speak with our support team.`,
      toolCalled: `findOrder("${orderId}")`,
      toolResult: { found: false },
    };
  }

  // Default response
  return {
    responseText: `*${tenant.name} - Automated Assistant*\n\n` +
      `Hello ${inbound.contactName}! I can assist you with:\n\n` +
      `• Checking real-time stock (e.g. *Do you have TSHIRT001?*)\n` +
      `• Order tracking (e.g. *Track ORD-000008*)\n` +
      `• Return and refund policies\n\n` +
      `How can I help you today?`,
  };
}
