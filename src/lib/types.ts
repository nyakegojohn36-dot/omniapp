/**
 * Universal Data Models & Types for SokoFlow
 * Global Multi-Tenant Ecommerce Automation Platform
 */

export type UserRole =
  | 'SUPER_ADMIN'
  | 'BUSINESS_OWNER'
  | 'SALES_STAFF'
  | 'FULFILLMENT_STAFF'
  | 'SUPPORT_STAFF'
  | 'CUSTOMER';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  currency: string;
  locale: string;
  timezone: string;
  taxRatePercent: number;
  taxInclusive: boolean;
  reservationTTLMinutes: number;
  plan: 'STARTER' | 'GROWTH' | 'ENTERPRISE';
  aiBudgetRemaining: number;
  channels: ('WEB' | 'WHATSAPP' | 'SHOPIFY_SYNC' | 'MARKETPLACE')[];
}

export interface User {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  role: UserRole;
  avatarUrl?: string;
}

export interface ProductVariant {
  id: string;
  sku: string;
  name: string;
  priceCents: number;
  compareAtPriceCents?: number;
  attributes: Record<string, string>; // e.g., { color: 'Navy', size: 'L' }
}

export interface Product {
  id: string;
  tenantId: string;
  sku: string;
  title: string;
  description: string;
  category: string;
  basePriceCents: number;
  currency: string;
  variants: ProductVariant[];
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  imageUrl?: string;
  createdAt: string;
}

export interface WarehouseInventory {
  sku: string;
  warehouseId: string;
  warehouseName: string;
  physicalStock: number;
  reservedStock: number;
  quarantineStock: number; // Damaged / inspection
  lowStockThreshold: number;
  lastReconciledAt: string;
}

export interface StockReservation {
  id: string;
  tenantId: string;
  orderId: string;
  sku: string;
  warehouseId: string;
  quantity: number;
  expiresAt: string; // ISO timestamp
  status: 'ACTIVE' | 'COMMITTED' | 'EXPIRED' | 'CANCELLED';
  createdAt: string;
}

export type OrderStatus =
  | 'DRAFT'
  | 'PENDING_CONFIRMATION'
  | 'AWAITING_PAYMENT'
  | 'PAYMENT_FAILED'
  | 'CONFIRMED'
  | 'PROCESSING'
  | 'READY_FOR_DISPATCH'
  | 'PARTIALLY_FULFILLED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLATION_REQUESTED'
  | 'CANCELLED'
  | 'RETURN_REQUESTED'
  | 'RETURNED'
  | 'REFUND_PENDING'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'ON_HOLD'
  | 'EXCEPTION_REVIEW';

export type PaymentMethod =
  | 'MPESA_EXPRESS'
  | 'MPESA_PAYBILL'
  | 'AIRTEL_MONEY'
  | 'CREDIT_CARD'
  | 'BANK_TRANSFER'
  | 'CASH_ON_DELIVERY'
  | 'DIGITAL_WALLET';

export interface OrderItem {
  id: string;
  productId: string;
  sku: string;
  title: string;
  variantName?: string;
  quantity: number;
  unitPriceCents: number; // Immutable price snapshot
  subtotalCents: number;
}

export interface OrderAddress {
  fullName: string;
  addressLine1: string; // Street / Estate / Apartment / Road
  addressLine2?: string; // Landmark / House No
  city: string; // City / Town (e.g. Nairobi, Mombasa, Kisumu, Nakuru, Eldoret)
  stateOrProvince?: string; // County (e.g. Nairobi County, Kiambu, Mombasa)
  postalCode: string; // Postal code or P.O. Box (e.g. 00100, 80100)
  countryCode: string; // KE for Kenya
  phone: string; // e.g. +254 752 720933 or 0752 720933
}

export interface OrderAuditEntry {
  id: string;
  timestamp: string;
  fromStatus?: OrderStatus;
  toStatus: OrderStatus;
  actor: string;
  actorRole: UserRole | 'SYSTEM' | 'AI_ASSISTANT';
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface Order {
  id: string; // e.g. ORD-000008
  tenantId: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  sourceChannel?: 'WEB' | 'WHATSAPP' | 'SHOPIFY_SYNC' | 'MARKETPLACE';
  whatsappSenderPhone?: string;
  items: OrderItem[];
  currency: string;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  discountCents: number;
  totalCents: number;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  isPaid: boolean;
  paymentTransactionRef?: string;
  mpesaReceiptCode?: string; // e.g. QKD73HD892
  mpesaPhoneNumber?: string; // e.g. 254752720933
  etimsInvoiceNumber?: string; // e.g. eTIMS-2026-NBI-00912
  shippingCarrier?: string; // e.g. Fargo Courier, Sendy Boda, G4S Kenya, Pick-up Mtaani
  trackingNumber?: string;
  shippingAddress: OrderAddress;
  auditTrail: OrderAuditEntry[];
  reservationId?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentTransaction {
  id: string;
  tenantId: string;
  orderId: string;
  provider:
    | 'MPESA_DARAJA'
    | 'AIRTEL_MONEY'
    | 'PESALINK_ADAPTER'
    | 'STRIPE_ADAPTER'
    | 'PAYPAL_ADAPTER'
    | 'COD_ADAPTER'
    | 'MOCK_GATEWAY';
  transactionRef: string;
  amountCents: number;
  currency: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'REFUNDED' | 'DISPUTED';
  idempotencyKey: string;
  rawWebhookEventId?: string;
  createdAt: string;
}

export interface SupportCaseInternalNote {
  id: string;
  author: string;
  authorRole: string;
  note: string;
  timestamp: string;
}

export interface SupportCase {
  id: string;
  tenantId: string;
  orderId?: string;
  customerId?: string;
  customerName?: string;
  customerEmail: string;
  customerPhone?: string;
  channel?: 'WHATSAPP' | 'WEB' | 'EMAIL';
  subject: string;
  status: 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'RESOLVED' | 'ESCALATED_TO_HUMAN';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  assignedStaffId?: string;
  handledByAi: boolean;
  humanTakeover?: boolean;
  internalNotes?: SupportCaseInternalNote[];
  messages: {
    sender: 'CUSTOMER' | 'AI_ASSISTANT' | 'STAFF';
    text: string;
    timestamp: string;
    status?: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  }[];
  createdAt: string;
}

export type WhatsAppOperatingMode =
  | 'DEVELOPER_SANDBOX'
  | 'CLIENT_BUSINESS_LIVE'
  | 'SIMULATED_DEMO'
  | 'META_TEST'
  | 'LIVE_PRODUCTION';

export interface WhatsAppCloudConfig {
  mode: WhatsAppOperatingMode;
  wabaId: string; // WhatsApp Business Account ID
  phoneNumberId: string; // Meta Phone Number ID
  displayPhoneNumber: string;
  verifyToken: string; // hub.verify_token
  accessTokenMasked: string;
  hasAccessToken: boolean;
  metaAppSecretMasked?: string;
  hasAppSecret?: boolean;
  graphApiVersion: string; // e.g. 'v22.0' (centralized, configurable)
  authorizedTestRecipient: string;
  webhookCallbackUrl: string;
  autoAiReplies: boolean;
  aiBusinessPrompt: string;
  allowSelfOrderCreation: boolean;
  connectedAt?: string;
  // Explicit diagnostic connection breakdown (never report fake "Connected" without proof)
  configurationSaved: boolean;
  credentialsValidated: boolean;
  webhookVerified: boolean;
  messageDeliveryActive: boolean;
}

export interface WhatsAppMessageRecord {
  id: string;
  wamid?: string;
  direction: 'INBOUND' | 'OUTBOUND';
  fromNumber: string;
  toNumber: string;
  customerName: string;
  textBody: string;
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  timestamp: string;
  sourceMode: WhatsAppOperatingMode;
  toolUsed?: string;
  errorMessage?: string;
  orderId?: string;
}

export interface WhatsAppCustomerSession {
  phoneNumber: string;
  customerName: string;
  step: 'IDLE' | 'AWAITING_QUANTITY' | 'AWAITING_ADDRESS' | 'AWAITING_CONFIRMATION' | 'ORDER_PLACED' | 'SUPPORT_HANDOVER';
  cart?: {
    sku: string;
    title: string;
    quantity: number;
    unitPriceCents: number;
    subtotalCents: number;
    taxCents: number;
    shippingCents: number;
    totalCents: number;
  };
  deliveryAddress?: OrderAddress;
  lastOrderId?: string;
  humanTakeover: boolean;
  lastActivityAt: string;
}

export interface WebhookEventRecord {
  id: string;
  tenantId: string;
  provider: string;
  eventType: string;
  idempotencyKey: string;
  processed: boolean;
  status: 'SUCCESS' | 'DUPLICATE_IGNORED' | 'ERROR';
  receivedAt: string;
  payload: Record<string, unknown>;
}

export interface FulfillmentTask {
  id: string;
  orderId: string;
  customerName: string;
  itemsCount: number;
  warehouseId: string;
  warehouseName: string;
  carrier: string;
  priority: 'NORMAL' | 'HIGH' | 'RUSH';
  stage: 'PICKING' | 'PACKING' | 'READY_FOR_DISPATCH' | 'DISPATCHED';
  assignedStaff: string;
  skuList: string[];
  barcode: string;
  slaTimeRemaining: string;
  packedAt?: string;
  dispatchedAt?: string;
  trackingNumber?: string;
}

export interface CustomerProfile {
  id: string;
  name: string;
  email: string;
  phone: string;
  avatarUrl: string;
  location: string;
  totalOrders: number;
  lifetimeSpendCents: number;
  vipStatus: boolean;
  tier: 'Platinum' | 'Gold' | 'Standard';
  lastOrderDate: string;
}

export interface IntegrationConfig {
  id: string;
  name: string;
  category: 'CHANNELS' | 'PAYMENT' | 'SHIPPING' | 'AUTOMATION';
  description: string;
  status: 'CONNECTED' | 'DISCONNECTED' | 'ATTENTION';
  icon: string;
  lastSyncAt: string;
  details: string;
}

export interface StaffMember {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  department: string;
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED';
  lastActive: string;
  assignedWarehouse?: string;
}
