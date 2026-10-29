import React, { useState, useEffect } from 'react';
import {
  ShoppingBag,
  Package,
  CheckCircle2,
  AlertCircle,
  Clock,
  ArrowRight,
  ShieldCheck,
  CreditCard,
  Truck,
  Trash2,
  Plus,
  Minus,
  Tag,
  Search,
  Filter,
  Eye,
  Bot,
  MessageSquare,
  Send,
  Sparkles,
  ChevronRight,
  Globe,
  MapPin,
  X,
  User,
  FileText,
  Printer,
} from 'lucide-react';
import { InventoryStore } from '../lib/inventoryEngine.ts';
import { createCustomerOrder } from '../lib/orderService.ts';
import { calculateOrderPricing, formatCurrency } from '../lib/pricingEngine.ts';
import { Order, OrderAddress, PaymentMethod, Product, Tenant, UserRole, WarehouseInventory } from '../lib/types.ts';
import { SEED_ORDERS } from '../lib/sampleData.ts';
import { KraTaxInvoiceModal } from './KraTaxInvoiceModal.tsx';

interface CustomerStorefrontViewProps {
  tenant: Tenant;
  products: Product[];
  inventories: WarehouseInventory[];
  inventoryEngine: InventoryStore;
  existingOrdersCount: number;
  currentRole?: UserRole;
  onOrderCreated: (newOrder: Order) => void;
  onNavigateTab: (tab: string) => void;
}

interface CartItem {
  productId: string;
  sku: string;
  title: string;
  variantName: string;
  unitPriceCents: number;
  quantity: number;
  imageUrl?: string;
  reservationId?: string;
}

const CURRENCY_RATES: Record<string, { symbol: string; rate: number; label: string }> = {
  KES: { symbol: 'KSh', rate: 1.0, label: 'KES (KSh)' },
  USD: { symbol: '$', rate: 0.0077, label: 'USD ($)' },
  EUR: { symbol: '€', rate: 0.0071, label: 'EUR (€)' },
  GBP: { symbol: '£', rate: 0.0061, label: 'GBP (£)' },
};

export const CustomerStorefrontView: React.FC<CustomerStorefrontViewProps> = ({
  tenant,
  products,
  inventories,
  inventoryEngine,
  existingOrdersCount,
  currentRole = 'CUSTOMER',
  onOrderCreated,
  onNavigateTab,
}) => {
  // Navigation within customer portal
  const [activeCustomerView, setActiveCustomerView] = useState<'storefront' | 'my-orders'>('storefront');

  // Search, Categories, and Currency Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const [selectedCurrency, setSelectedCurrency] = useState<string>(tenant.currency || 'KES');

  // Cart state & TTL countdown
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCartDrawerOpen, setIsCartDrawerOpen] = useState(false);
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [discountCode, setDiscountCode] = useState<string>('WELCOME10');
  const [appliedDiscount, setAppliedDiscount] = useState<string>('WELCOME10');
  const [orderError, setOrderError] = useState<string | null>(null);

  // Product Detail Modal
  const [quickviewProduct, setQuickviewProduct] = useState<Product | null>(null);

  // 3-Step Checkout Modal
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [checkoutStep, setCheckoutStep] = useState<1 | 2 | 3>(1);
  const [confirmedOrder, setConfirmedOrder] = useState<Order | null>(null);
  const [invoiceModalOrder, setInvoiceModalOrder] = useState<Order | null>(null);

  // Safaricom M-PESA STK Push Simulation State
  const [mpesaPhone, setMpesaPhone] = useState<string>('0752720933');
  const [stkState, setStkState] = useState<'idle' | 'sending_prompt' | 'awaiting_pin' | 'authorized'>('idle');
  const [activeReceiptCode, setActiveReceiptCode] = useState<string | null>(null);

  // Countdown timer for cart hold TTL (15 minutes)
  const [timeLeftSeconds, setTimeLeftSeconds] = useState<number>(15 * 60);

  // Floating AI Shopping Assistant Concierge
  const [isAiConciergeOpen, setIsAiConciergeOpen] = useState(false);
  const [aiChatMessages, setAiChatMessages] = useState<
    { sender: 'AI' | 'USER'; text: string; recommendedSku?: string }[]
  >([
    {
      sender: 'AI',
      text: `Jambo! I'm your Safari Peak Kenya shopping concierge. Looking for trail apparel, Mt. Kenya expedition gear, sizes, or checking stock in our Nairobi & Mombasa warehouses? Ask me anything!`,
    },
  ]);
  const [aiChatInput, setAiChatInput] = useState('');

  // Form Fields - Default Kenyan Customer
  const [shippingAddress, setShippingAddress] = useState<OrderAddress>({
    fullName: 'Sarah Nekesa',
    addressLine1: 'Parklands Road, Westlands Plaza 4th Floor',
    city: 'Nairobi',
    stateOrProvince: 'Nairobi County',
    postalCode: '00100',
    countryCode: 'KE',
    phone: '+254 752 720933',
  });
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('MPESA_EXPRESS');

  // My Orders list
  const [myOrders, setMyOrders] = useState<Order[]>(SEED_ORDERS);
  const [storeWhatsAppPhone, setStoreWhatsAppPhone] = useState<string>('254752720933');

  useEffect(() => {
    fetch('/api/whatsapp/config')
      .then((r) => r.json())
      .then((d) => {
        if (d?.displayPhoneNumber && !d.displayPhoneNumber.includes('Sandbox')) {
          setStoreWhatsAppPhone(d.displayPhoneNumber.replace(/\D/g, ''));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (cart.length === 0) return;
    const interval = setInterval(() => {
      setTimeLeftSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [cart.length]);

  // Currency conversion helper (Base currency is KES)
  const currencyInfo = CURRENCY_RATES[selectedCurrency] || CURRENCY_RATES.KES;
  const formatLocalPrice = (centsInBaseCurrency: number) => {
    const converted = (centsInBaseCurrency / 100) * currencyInfo.rate;
    if (selectedCurrency === 'KES') {
      return `KSh ${Math.round(converted).toLocaleString('en-KE')}`;
    }
    return `${currencyInfo.symbol}${converted.toFixed(2)}`;
  };

  // Add to cart handler
  const handleAddToCart = (product: Product, forcedSku?: string) => {
    setOrderError(null);
    const chosenVariantSku =
      forcedSku || selectedVariants[product.id] || product.variants[0]?.sku || product.sku;
    const variantObj = product.variants.find((v) => v.sku === chosenVariantSku);
    const variantLabel = variantObj ? variantObj.name : 'Standard';
    const qty = quantities[product.id] || 1;

    // Check availability
    const stock = inventoryEngine.getAvailability(chosenVariantSku);
    if (stock.availableStock < qty) {
      if (stock.availableStock === 0) {
        setOrderError(`Sorry, ${product.title} (${chosenVariantSku}) is completely out of stock.`);
      } else {
        setOrderError(`Only ${stock.availableStock} units of ${product.title} are available.`);
      }
      return;
    }

    setCart((prev) => {
      const existingIdx = prev.findIndex((item) => item.sku === chosenVariantSku);
      if (existingIdx > -1) {
        const copy = [...prev];
        copy[existingIdx].quantity += qty;
        return copy;
      }
      return [
        ...prev,
        {
          productId: product.id,
          sku: chosenVariantSku,
          title: product.title,
          variantName: variantLabel,
          unitPriceCents: variantObj?.priceCents || product.basePriceCents,
          quantity: qty,
          imageUrl: product.imageUrl,
        },
      ];
    });

    setTimeLeftSeconds(tenant.reservationTTLMinutes * 60);
    setIsCartDrawerOpen(true);
    if (quickviewProduct) setQuickviewProduct(null);
  };

  const handleUpdateCartQuantity = (sku: string, delta: number) => {
    setCart((prev) => {
      return prev
        .map((item) => {
          if (item.sku === sku) {
            const newQty = item.quantity + delta;
            return newQty > 0 ? { ...item, quantity: newQty } : null;
          }
          return item;
        })
        .filter(Boolean) as CartItem[];
    });
  };

  const handleRemoveItem = (sku: string) => {
    setCart((prev) => prev.filter((i) => i.sku !== sku));
  };

  // Pricing calculation
  const pricingSummary = calculateOrderPricing({
    items: cart.map((i) => ({ sku: i.sku, unitPriceCents: i.unitPriceCents, quantity: i.quantity })),
    currency: tenant.currency,
    taxRatePercent: tenant.taxRatePercent,
    taxInclusive: tenant.taxInclusive,
    shippingCountryCode: shippingAddress.countryCode,
    discountCode: appliedDiscount,
  });

  // Free shipping threshold for Kenya (KSh 10,000 / 1,000,000 cents)
  const freeShippingThresholdCents = 1000000;
  const progressToFreeShipping = Math.min(
    100,
    Math.round((pricingSummary.subtotalCents / freeShippingThresholdCents) * 100)
  );
  const amountNeededForFreeShippingCents = Math.max(0, freeShippingThresholdCents - pricingSummary.subtotalCents);

  // Submit and Place Order with M-PESA STK Push Simulation
  const handlePlaceOrder = () => {
    setOrderError(null);

    const highestOrderNum = Math.max(
      8,
      existingOrdersCount,
      ...myOrders.map((o) => {
        const num = parseInt(o.id.replace(/\D/g, ''), 10);
        return isNaN(num) ? 0 : num;
      })
    );

    const proceedWithCreation = (prepaid: boolean, receipt?: string) => {
      const result = createCustomerOrder({
        tenant,
        inventoryEngine,
        customerName: shippingAddress.fullName,
        customerEmail: 'sarah.nekesa@gmail.com',
        customerPhone: shippingAddress.phone || mpesaPhone,
        items: cart,
        shippingAddress,
        paymentMethod,
        discountCode: appliedDiscount,
        existingOrderIdCount: highestOrderNum,
        prepaidApproved: prepaid,
        mpesaPhoneNumber: mpesaPhone,
        mpesaReceiptCode: receipt,
      });

      if (result.success && result.order) {
        onOrderCreated(result.order);
        setConfirmedOrder(result.order);
        setMyOrders((prev) => [result.order!, ...prev.filter((o) => o.id !== result.order!.id)]);
        setCart([]);
        setStkState('idle');
        setIsCheckoutOpen(false);
        setCheckoutStep(1);
      } else {
        setStkState('idle');
        setOrderError(result.error || 'Failed to place order.');
      }
    };

    // If Safaricom M-PESA STK Push selected, simulate realistic Daraja flow
    if (paymentMethod === 'MPESA_EXPRESS') {
      setStkState('sending_prompt');
      setTimeout(() => {
        setStkState('awaiting_pin');
        setTimeout(() => {
          const generatedReceipt = `QK${Math.floor(10000000 + Math.random() * 90000000)}`;
          setActiveReceiptCode(generatedReceipt);
          setStkState('authorized');
          setTimeout(() => {
            proceedWithCreation(true, generatedReceipt);
          }, 600);
        }, 1200);
      }, 700);
    } else {
      const isPrepaid = paymentMethod === 'MPESA_PAYBILL' || paymentMethod === 'AIRTEL_MONEY' || paymentMethod === 'CREDIT_CARD';
      const receipt = paymentMethod === 'MPESA_PAYBILL' ? `RK${Math.floor(10000000 + Math.random() * 90000000)}` : undefined;
      proceedWithCreation(isPrepaid, receipt);
    }
  };

  // AI Concierge Chat Handler - Grounded in Kenya
  const handleSendAiMessage = () => {
    const text = aiChatInput.trim();
    if (!text) return;

    setAiChatMessages((prev) => [...prev, { sender: 'USER', text }]);
    setAiChatInput('');

    // Simulate smart grounded Kenyan retail AI responses
    setTimeout(() => {
      const lower = text.toLowerCase();
      if (lower.includes('delivery') || lower.includes('shipping') || lower.includes('nairobi') || lower.includes('upcountry')) {
        setAiChatMessages((prev) => [
          ...prev,
          {
            sender: 'AI',
            text: `We deliver across Nairobi (Westlands, Kilimani, Karen, Upper Hill, CBD) same-day via Sendy/Boda courier in 2-4 hours for KSh 300. Upcountry orders (Mombasa, Kisumu, Nakuru, Eldoret) are dispatched via Fargo/G4S within 24 hours for KSh 500. Orders over KSh 10,000 qualify for FREE delivery!`,
          },
        ]);
      } else if (lower.includes('mpesa') || lower.includes('m-pesa') || lower.includes('pay') || lower.includes('payment') || lower.includes('till')) {
        setAiChatMessages((prev) => [
          ...prev,
          {
            sender: 'AI',
            text: `We support instant Lipa na M-PESA STK Push (prompt sent directly to your phone), M-PESA Paybill 247247 (Acc: SafariPeak), Buy Goods Till 542910, Airtel Money Kenya, Pesalink bank transfers, or Cash/M-PESA on Delivery with our Boda riders.`,
          },
        ]);
      } else if (lower.includes('etims') || lower.includes('vat') || lower.includes('tax') || lower.includes('kra')) {
        setAiChatMessages((prev) => [
          ...prev,
          {
            sender: 'AI',
            text: `All prices include 16% standard KRA VAT. Every order automatically receives an official KRA eTIMS fiscal electronic receipt with verifiable QR code.`,
          },
        ]);
      } else if (lower.includes('jacket') || lower.includes('alpine') || lower.includes('cold') || lower.includes('parka')) {
        const prod = products.find((p) => p.sku === 'JKT-ALPINE-09') || products[0];
        setAiChatMessages((prev) => [
          ...prev,
          {
            sender: 'AI',
            text: `The ${prod.title} (KSh ${(prod.basePriceCents / 100).toLocaleString('en-KE')}) is insulated with 800-fill down, engineered specifically for high-altitude expeditions like Mt. Kenya Point Lenana or the Aberdares. Stock is ready at our Nairobi Industrial Area hub!`,
            recommendedSku: prod.sku,
          },
        ]);
      } else if (lower.includes('tshirt') || lower.includes('t-shirt') || lower.includes('shirt') || lower.includes('trail')) {
        const prod = products.find((p) => p.sku === 'TSHIRT001') || products[0];
        setAiChatMessages((prev) => [
          ...prev,
          {
            sender: 'AI',
            text: `Our ${prod.title} is KSh ${(prod.basePriceCents / 100).toLocaleString('en-KE')}. Crafted from breathable moisture-wicking organic cotton, perfect for Karura Forest trail runs or Hell's Gate biking.`,
            recommendedSku: prod.sku,
          },
        ]);
      } else {
        const prod = products[0];
        setAiChatMessages((prev) => [
          ...prev,
          {
            sender: 'AI',
            text: `Karibu! Check out our best-selling ${prod.title} (KSh ${(prod.basePriceCents / 100).toLocaleString('en-KE')}). Would you like me to add it to your shopping cart or assist with sizes?`,
            recommendedSku: prod.sku,
          },
        ]);
      }
    }, 500);
  };

  const categories = ['ALL', 'Apparel', 'Footwear', 'Accessories', 'Equipment'];
  const filteredProducts = products.filter((p) => {
    if (selectedCategory !== 'ALL' && p.category.toLowerCase() !== selectedCategory.toLowerCase()) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        p.title.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const minutes = Math.floor(timeLeftSeconds / 60);
  const seconds = timeLeftSeconds % 60;
  const formattedCountdown = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  return (
    <div className="space-y-8 relative">
      {/* Top Storefront Bar: Search, Currency & View Toggle */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 bg-white border border-slate-200 rounded-2xl p-4 shadow-2xs">
        {/* Left: View Switcher (Storefront vs Customer Orders Portal) */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-100 rounded-xl text-xs font-semibold">
          <button
            onClick={() => setActiveCustomerView('storefront')}
            className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${
              activeCustomerView === 'storefront'
                ? 'bg-white text-slate-900 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Package className="w-3.5 h-3.5 text-slate-700" />
            <span>Storefront & Catalog</span>
          </button>

          <button
            onClick={() => setActiveCustomerView('my-orders')}
            className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${
              activeCustomerView === 'my-orders'
                ? 'bg-white text-slate-900 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <User className="w-3.5 h-3.5 text-slate-700" />
            <span>My Orders & Tracking ({myOrders.length})</span>
          </button>
        </div>

        {/* Right: Currency & Cart Trigger */}
        <div className="flex items-center gap-3">
          {/* Currency Switcher */}
          <div className="flex items-center gap-1.5 text-xs text-slate-600">
            <Globe className="w-3.5 h-3.5 text-slate-400" />
            <select
              value={selectedCurrency}
              onChange={(e) => setSelectedCurrency(e.target.value)}
              className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-900 focus:outline-none"
            >
              {Object.keys(CURRENCY_RATES).map((cur) => (
                <option key={cur} value={cur}>
                  {CURRENCY_RATES[cur].label}
                </option>
              ))}
            </select>
          </div>

          {/* Cart Button */}
          <button
            onClick={() => setIsCartDrawerOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-slate-800 transition-colors shadow-2xs"
          >
            <ShoppingBag className="w-4 h-4 text-emerald-400" />
            <span>Cart ({cart.reduce((s, i) => s + i.quantity, 0)})</span>
            {cart.length > 0 && (
              <span className="font-mono tabular-nums bg-slate-800 px-2 py-0.5 rounded text-[11px]">
                {formatLocalPrice(pricingSummary.totalCents)}
              </span>
            )}
          </button>
        </div>
      </div>

      {orderError && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <div>
            <strong>Notice:</strong> {orderError}
          </div>
        </div>
      )}

      {/* VIEW A: STOREFRONT & CATALOG */}
      {activeCustomerView === 'storefront' && (
        <div className="space-y-8">
          {/* Hero Banner */}
          <div className="relative rounded-2xl bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 text-white p-8 sm:p-12 overflow-hidden shadow-lg border border-slate-800">
            <div className="relative z-10 max-w-2xl space-y-3">
              <span className="px-3 py-1 bg-white/10 backdrop-blur-md rounded-full text-xs font-bold uppercase tracking-wider text-emerald-300">
                Safari Peak Outfitters Kenya · Nairobi
              </span>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
                Precision Outdoor Gear. Built For East African Expeditions.
              </h2>
              <p className="text-sm text-slate-300 leading-relaxed">
                Technical apparel, safari backpacks, and expedition gear. Nairobi same-day boda dispatch (2-4 hrs) & upcountry Fargo/G4S delivery with instant Lipa na M-PESA.
              </p>
              <div className="pt-2 flex flex-wrap items-center gap-3">
                <span className="text-xs bg-emerald-500/20 text-emerald-300 px-3 py-1 rounded-full font-semibold border border-emerald-500/30">
                  Use code WELCOME10 for 10% off
                </span>
                <span className="text-xs text-slate-400">· Free delivery across Kenya over KSh 10,000</span>
              </div>
            </div>
          </div>

          {/* Search & Category Filter Navigation */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            {/* Category Pills */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-3.5 py-1.5 rounded-lg whitespace-nowrap transition-colors font-medium ${
                    selectedCategory === cat
                      ? 'bg-slate-900 text-white font-bold shadow-2xs'
                      : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* Search Input */}
            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search products by title, SKU..."
                className="w-full pl-9 pr-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-900 shadow-2xs"
              />
            </div>
          </div>

          {/* Product Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {filteredProducts.map((product) => {
              const selectedSku =
                selectedVariants[product.id] || product.variants[0]?.sku || product.sku;
              const availability = inventoryEngine.getAvailability(selectedSku);
              const isAvailable = availability.availableStock > 0;
              const isLowStock = isAvailable && availability.availableStock <= 5;

              return (
                <div
                  key={product.id}
                  className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs hover:shadow-md transition-shadow flex flex-col justify-between group"
                >
                  <div>
                    {/* Image Area */}
                    <div className="relative aspect-square bg-slate-100 overflow-hidden">
                      <img
                        src={product.imageUrl}
                        alt={product.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                      <div className="absolute top-3 right-3 flex flex-col gap-1 items-end">
                        {isAvailable ? (
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold shadow-2xs ${
                              isLowStock
                                ? 'bg-amber-100 text-amber-900 border border-amber-200'
                                : 'bg-emerald-100 text-emerald-900 border border-emerald-200'
                            }`}
                          >
                            {isLowStock ? `Only ${availability.availableStock} left` : 'In Stock'}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 bg-rose-100 text-rose-900 border border-rose-200 rounded-full text-[10px] font-bold shadow-2xs">
                            Sold Out
                          </span>
                        )}
                      </div>

                      <button
                        onClick={() => setQuickviewProduct(product)}
                        className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-white/90 backdrop-blur-xs text-slate-800 rounded-lg text-xs font-semibold opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 shadow-md"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>Quick View</span>
                      </button>
                    </div>

                    {/* Details Area */}
                    <div className="p-4 space-y-2">
                      <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">
                        {product.category} · {product.sku}
                      </div>

                      <h3 className="font-bold text-sm text-slate-900 line-clamp-1">
                        {product.title}
                      </h3>

                      <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed">
                        {product.description}
                      </p>

                      <div className="pt-1 flex items-baseline justify-between">
                        <span className="font-mono text-base font-extrabold text-slate-900">
                          {formatLocalPrice(product.basePriceCents)}
                        </span>
                        <span className="text-[11px] text-slate-400">
                          Tax {tenant.taxInclusive ? 'Inc.' : 'Excl.'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Add to Cart & WhatsApp Bar */}
                  <div className="p-4 pt-0 space-y-2">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleAddToCart(product)}
                        disabled={!isAvailable}
                        className={`flex-1 py-2.5 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
                          isAvailable
                            ? 'bg-slate-900 text-white hover:bg-slate-800 shadow-2xs'
                            : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                        }`}
                      >
                        <ShoppingBag className="w-3.5 h-3.5" />
                        <span>{isAvailable ? 'Add to Cart' : 'Sold Out'}</span>
                      </button>

                      {isAvailable && (
                        <button
                          onClick={() => {
                            const msg = `Jambo! I want to order "${product.title}" (SKU: ${product.sku}, Price: KSh ${(
                              product.basePriceCents / 100
                            ).toLocaleString('en-KE')}) via WhatsApp.`;
                            if (storeWhatsAppPhone) {
                              window.open(`https://wa.me/${storeWhatsAppPhone}?text=${encodeURIComponent(msg)}`, '_blank');
                            } else {
                              setIsAiConciergeOpen(true);
                              setAiChatInput(`Buy ${product.sku}`);
                            }
                          }}
                          title="Order on WhatsApp / AI Assistant"
                          className="p-2.5 rounded-xl bg-[#25D366] hover:bg-[#20bd5a] text-white transition-colors shadow-2xs flex items-center justify-center group"
                        >
                          <MessageSquare className="w-3.5 h-3.5 fill-white/20 group-hover:scale-110 transition-transform" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* VIEW B: CUSTOMER ORDERS & LIVE TRACKING */}
      {activeCustomerView === 'my-orders' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-2xs">
            <h3 className="text-lg font-bold text-slate-900">Order History & Live Dispatch Status</h3>
            <p className="text-xs text-slate-500 mt-1">
              Track fulfillment progress in real-time, view carrier tracking, and manage receipts.
            </p>
          </div>

          <div className="space-y-4">
            {myOrders.map((ord) => {
              const isDelivered = ord.status === 'DELIVERED';
              const isShipped = ord.status === 'SHIPPED';
              const isProcessing = ord.status === 'PROCESSING' || ord.status === 'CONFIRMED';
              const isAwaiting = ord.status === 'AWAITING_PAYMENT';

              return (
                <div
                  key={ord.id}
                  className="bg-white border border-slate-200 rounded-2xl p-6 shadow-2xs space-y-4"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-3 border-b border-slate-100">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-sm text-slate-900">{ord.id}</span>
                        <span className="text-slate-300">·</span>
                        <span className="text-xs text-slate-500 font-mono">
                          Placed on {new Date(ord.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="font-mono font-bold text-sm text-slate-900">
                        {formatCurrency(ord.totalCents, ord.currency)}
                      </span>
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                          isDelivered
                            ? 'bg-emerald-100 text-emerald-800'
                            : isShipped
                            ? 'bg-blue-100 text-blue-800'
                            : isProcessing
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {ord.status.replace(/_/g, ' ')}
                      </span>
                    </div>
                  </div>

                  {/* Visual Tracking Stepper */}
                  <div className="py-2">
                    <div className="grid grid-cols-4 gap-2 text-center text-xs">
                      <div className="space-y-1">
                        <div
                          className={`w-7 h-7 mx-auto rounded-full flex items-center justify-center font-bold text-xs ${
                            ord.status !== 'CANCELLED'
                              ? 'bg-emerald-600 text-white'
                              : 'bg-slate-200 text-slate-500'
                          }`}
                        >
                          1
                        </div>
                        <span className="font-semibold text-slate-800 block text-[11px]">Placed & Confirmed</span>
                      </div>

                      <div className="space-y-1">
                        <div
                          className={`w-7 h-7 mx-auto rounded-full flex items-center justify-center font-bold text-xs ${
                            isProcessing || isShipped || isDelivered
                              ? 'bg-emerald-600 text-white'
                              : 'bg-slate-200 text-slate-500'
                          }`}
                        >
                          2
                        </div>
                        <span className="font-semibold text-slate-800 block text-[11px]">Warehouse Packing</span>
                      </div>

                      <div className="space-y-1">
                        <div
                          className={`w-7 h-7 mx-auto rounded-full flex items-center justify-center font-bold text-xs ${
                            isShipped || isDelivered
                              ? 'bg-emerald-600 text-white'
                              : 'bg-slate-200 text-slate-500'
                          }`}
                        >
                          3
                        </div>
                        <span className="font-semibold text-slate-800 block text-[11px]">Dispatched In Transit</span>
                      </div>

                      <div className="space-y-1">
                        <div
                          className={`w-7 h-7 mx-auto rounded-full flex items-center justify-center font-bold text-xs ${
                            isDelivered ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-500'
                          }`}
                        >
                          4
                        </div>
                        <span className="font-semibold text-slate-800 block text-[11px]">Delivered</span>
                      </div>
                    </div>
                  </div>

                  {/* Carrier & M-PESA / eTIMS Fiscal Info */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono">
                    <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-slate-600">
                        <Truck className="w-3.5 h-3.5" />
                        <span>{ord.shippingCarrier || 'Sendy / Nairobi Boda Courier'}</span>
                      </div>
                      <div className="text-slate-800 font-bold">
                        {ord.trackingNumber || 'Assigned to Rider'}
                      </div>
                    </div>

                    {(ord.mpesaReceiptCode || ord.etimsInvoiceNumber) && (
                      <div className="p-2.5 bg-emerald-50/60 border border-emerald-200 rounded-xl flex items-center justify-between">
                        {ord.mpesaReceiptCode && (
                          <div className="flex items-center gap-1 text-emerald-800 font-bold">
                            <span>M-PESA:</span>
                            <span>{ord.mpesaReceiptCode}</span>
                          </div>
                        )}
                        {ord.etimsInvoiceNumber && (
                          <div className="text-slate-700 text-[11px] font-semibold">
                            <span>KRA eTIMS:</span> {ord.etimsInvoiceNumber}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* KRA eTIMS Tax Invoice & Action */}
                  <div className="flex items-center justify-between pt-1">
                    <button
                      type="button"
                      onClick={() => setInvoiceModalOrder(ord)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold border border-indigo-200 transition-colors cursor-pointer"
                    >
                      <FileText className="w-3.5 h-3.5 text-indigo-600" />
                      <span>View eTIMS Tax Invoice</span>
                    </button>
                    <span className="text-[11px] text-slate-400 font-mono">
                      VAT 16% Compliant
                    </span>
                  </div>

                  {/* Items List */}
                  <div className="divide-y divide-slate-100 text-xs">
                    {ord.items.map((item) => (
                      <div key={item.id} className="py-2 flex items-center justify-between">
                        <div>
                          <div className="font-bold text-slate-900">{item.title}</div>
                          <div className="text-[11px] text-slate-500 font-mono">
                            {item.sku} · Qty {item.quantity}
                          </div>
                        </div>
                        <span className="font-mono font-semibold text-slate-800">
                          {formatCurrency(item.subtotalCents, ord.currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* SLIDE-OUT CART DRAWER */}
      {isCartDrawerOpen && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-slate-900/50 backdrop-blur-xs flex justify-end">
          <div className="w-full max-w-md bg-white h-full shadow-2xl flex flex-col justify-between animate-slide-left">
            {/* Header */}
            <div className="p-5 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShoppingBag className="w-5 h-5 text-slate-800" />
                <h3 className="font-bold text-base text-slate-900">
                  Shopping Cart ({cart.reduce((s, i) => s + i.quantity, 0)})
                </h3>
              </div>
              <button
                onClick={() => setIsCartDrawerOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Cart Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* Free Shipping Progress */}
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5 text-xs">
                <div className="flex items-center justify-between font-semibold text-slate-800">
                  {amountNeededForFreeShippingCents > 0 ? (
                    <span>
                      Add {formatLocalPrice(amountNeededForFreeShippingCents)} more for Free Shipping!
                    </span>
                  ) : (
                    <span className="text-emerald-700 font-bold flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Congratulations! You unlocked Free Worldwide Shipping!
                    </span>
                  )}
                </div>
                <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-slate-900 h-full rounded-full transition-all duration-300"
                    style={{ width: `${progressToFreeShipping}%` }}
                  ></div>
                </div>
              </div>

              {/* TTL Hold Countdown */}
              {cart.length > 0 && (
                <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
                  <Clock className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                  <span>
                    Stock reservation hold active for: <strong className="font-mono">{formattedCountdown}</strong>
                  </span>
                </div>
              )}

              {/* Items List */}
              {cart.length === 0 ? (
                <div className="text-center py-16 text-slate-400 text-xs space-y-3">
                  <ShoppingBag className="w-10 h-10 mx-auto text-slate-300" />
                  <p>Your shopping cart is currently empty.</p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {cart.map((item) => (
                    <div key={item.sku} className="py-3.5 flex items-center gap-3">
                      {item.imageUrl && (
                        <img
                          src={item.imageUrl}
                          alt={item.title}
                          className="w-14 h-14 rounded-lg object-cover border border-slate-200"
                        />
                      )}
                      <div className="flex-1 min-w-0 space-y-1">
                        <h4 className="font-bold text-xs text-slate-900 truncate">{item.title}</h4>
                        <div className="text-[11px] text-slate-500 font-mono">
                          {item.sku} · {item.variantName}
                        </div>
                        <div className="font-mono font-bold text-xs text-slate-900">
                          {formatLocalPrice(item.unitPriceCents * item.quantity)}
                        </div>
                      </div>

                      {/* Quantity Stepper */}
                      <div className="flex items-center gap-1.5 border border-slate-200 rounded-lg p-1 bg-slate-50">
                        <button
                          onClick={() => handleUpdateCartQuantity(item.sku, -1)}
                          className="p-1 hover:bg-slate-200 rounded text-slate-600"
                        >
                          <Minus className="w-3 h-3" />
                        </button>
                        <span className="font-mono text-xs font-bold px-1.5">{item.quantity}</span>
                        <button
                          onClick={() => handleUpdateCartQuantity(item.sku, 1)}
                          className="p-1 hover:bg-slate-200 rounded text-slate-600"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>

                      <button
                        onClick={() => handleRemoveItem(item.sku)}
                        className="text-slate-400 hover:text-rose-600 p-1"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Cart Footer */}
            {cart.length > 0 && (
              <div className="p-5 border-t border-slate-200 bg-slate-50 space-y-4">
                {/* Promo Code Input */}
                <div className="flex items-center gap-2">
                  <Tag className="w-3.5 h-3.5 text-slate-500" />
                  <input
                    type="text"
                    value={discountCode}
                    onChange={(e) => setDiscountCode(e.target.value)}
                    placeholder="Promo code (WELCOME10)"
                    className="flex-1 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono uppercase"
                  />
                  <button
                    onClick={() => setAppliedDiscount(discountCode.trim().toUpperCase())}
                    className="px-3 py-1.5 bg-slate-800 text-white rounded-lg text-xs font-semibold hover:bg-slate-900"
                  >
                    Apply
                  </button>
                </div>

                <div className="space-y-1.5 text-xs font-mono">
                  <div className="flex justify-between text-slate-600">
                    <span>Subtotal</span>
                    <span>{formatLocalPrice(pricingSummary.subtotalCents)}</span>
                  </div>
                  {pricingSummary.discountCents > 0 && (
                    <div className="flex justify-between text-emerald-700 font-bold">
                      <span>Discount ({appliedDiscount})</span>
                      <span>-{formatLocalPrice(pricingSummary.discountCents)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-slate-600">
                    <span>Shipping</span>
                    <span>
                      {pricingSummary.shippingCents === 0
                        ? 'FREE'
                        : formatLocalPrice(pricingSummary.shippingCents)}
                    </span>
                  </div>
                  <div className="flex justify-between text-base font-bold text-slate-900 pt-2 border-t border-slate-200">
                    <span>Estimated Total</span>
                    <span>{formatLocalPrice(pricingSummary.totalCents)}</span>
                  </div>
                </div>

                <button
                  onClick={() => {
                    setIsCartDrawerOpen(false);
                    setIsCheckoutOpen(true);
                  }}
                  className="w-full py-3 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-slate-800 shadow-md flex items-center justify-center gap-2"
                >
                  <span>Proceed to 3-Step Checkout</span>
                  <ArrowRight className="w-4 h-4 text-emerald-400" />
                </button>

                <button
                  onClick={() => {
                    const msg = `Jambo Safari Peak Kenya! I want to checkout my cart (${cart.length} item${cart.length > 1 ? 's' : ''}):\n` +
                      cart.map((c) => `• ${c.quantity}x ${c.title} (KSh ${(c.unitPriceCents / 100).toLocaleString('en-KE')})`).join('\n') +
                      `\nTotal Estimated: KSh ${(pricingSummary.totalCents / 100).toLocaleString('en-KE')}\nPlease initiate my M-PESA STK Push!`;
                    if (storeWhatsAppPhone) {
                      window.open(`https://wa.me/${storeWhatsAppPhone}?text=${encodeURIComponent(msg)}`, '_blank');
                    } else {
                      setIsCartDrawerOpen(false);
                      setIsAiConciergeOpen(true);
                      setAiChatInput('I want to checkout my cart on WhatsApp via M-PESA');
                    }
                  }}
                  className="w-full py-2.5 bg-[#25D366] hover:bg-[#20bd5a] text-white rounded-xl text-xs font-bold shadow-2xs flex items-center justify-center gap-2 transition-colors"
                >
                  <MessageSquare className="w-4 h-4 fill-white/20" />
                  <span>
                    {storeWhatsAppPhone
                      ? `Order via WhatsApp (+${storeWhatsAppPhone})`
                      : 'Order via WhatsApp Assistant'}
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* QUICK VIEW PRODUCT MODAL */}
      {quickviewProduct && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <span className="font-mono text-xs text-slate-500 font-bold uppercase tracking-wider">
                Product Specifications · {quickviewProduct.sku}
              </span>
              <button
                onClick={() => setQuickviewProduct(null)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 items-center">
              <div className="aspect-square bg-slate-100 rounded-xl overflow-hidden">
                <img
                  src={quickviewProduct.imageUrl}
                  alt={quickviewProduct.title}
                  className="w-full h-full object-cover"
                />
              </div>

              <div className="space-y-4">
                <div>
                  <h3 className="text-xl font-bold text-slate-900">{quickviewProduct.title}</h3>
                  <div className="mt-1 font-mono text-lg font-extrabold text-slate-900">
                    {formatLocalPrice(quickviewProduct.basePriceCents)}
                  </div>
                </div>

                <p className="text-xs text-slate-600 leading-relaxed">
                  {quickviewProduct.description}
                </p>

                {/* Available Variants */}
                {quickviewProduct.variants.length > 0 && (
                  <div className="space-y-1.5 text-xs">
                    <span className="font-bold text-slate-700 block">Available Variants:</span>
                    <div className="flex flex-wrap gap-2">
                      {quickviewProduct.variants.map((v) => (
                        <button
                          key={v.sku}
                          onClick={() =>
                            setSelectedVariants((prev) => ({ ...prev, [quickviewProduct.id]: v.sku }))
                          }
                          className={`px-3 py-1.5 rounded-lg border text-xs font-semibold ${
                            (selectedVariants[quickviewProduct.id] || quickviewProduct.variants[0].sku) === v.sku
                              ? 'border-slate-900 bg-slate-900 text-white'
                              : 'border-slate-200 bg-slate-50 text-slate-700'
                          }`}
                        >
                          {v.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <button
                  onClick={() => handleAddToCart(quickviewProduct)}
                  className="w-full py-2.5 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-slate-800 flex items-center justify-center gap-2 shadow-sm"
                >
                  <ShoppingBag className="w-4 h-4 text-emerald-400" />
                  <span>Add to Shopping Cart</span>
                </button>

                <button
                  onClick={() => {
                    const msg = `Jambo! I want to order "${quickviewProduct.title}" (SKU: ${quickviewProduct.sku}, Price: KSh ${(
                      quickviewProduct.basePriceCents / 100
                    ).toLocaleString('en-KE')}) via WhatsApp.`;
                    if (storeWhatsAppPhone) {
                      window.open(`https://wa.me/${storeWhatsAppPhone}?text=${encodeURIComponent(msg)}`, '_blank');
                    } else {
                      setQuickviewProduct(null);
                      setIsAiConciergeOpen(true);
                      setAiChatInput(`Buy ${quickviewProduct.sku}`);
                    }
                  }}
                  className="w-full py-2.5 bg-[#25D366] hover:bg-[#20bd5a] text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 shadow-sm transition-colors"
                >
                  <MessageSquare className="w-4 h-4 fill-white/20" />
                  <span>
                    {storeWhatsAppPhone
                      ? `Order via WhatsApp (+${storeWhatsAppPhone})`
                      : 'Order via WhatsApp Assistant'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3-STEP CHECKOUT MODAL */}
      {isCheckoutOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-xl w-full p-6 shadow-2xl border border-slate-200 space-y-5">
            {/* Step Indicators */}
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div className="flex items-center gap-4 text-xs font-bold">
                <span
                  className={`flex items-center gap-1.5 ${
                    checkoutStep === 1 ? 'text-slate-900 font-extrabold' : 'text-slate-400'
                  }`}
                >
                  <span className="w-5 h-5 rounded-full bg-slate-900 text-white flex items-center justify-center text-[10px]">
                    1
                  </span>
                  Shipping
                </span>
                <ChevronRight className="w-3.5 h-3.5 text-slate-300" />
                <span
                  className={`flex items-center gap-1.5 ${
                    checkoutStep === 2 ? 'text-slate-900 font-extrabold' : 'text-slate-400'
                  }`}
                >
                  <span className="w-5 h-5 rounded-full bg-slate-900 text-white flex items-center justify-center text-[10px]">
                    2
                  </span>
                  Payment
                </span>
                <ChevronRight className="w-3.5 h-3.5 text-slate-300" />
                <span
                  className={`flex items-center gap-1.5 ${
                    checkoutStep === 3 ? 'text-slate-900 font-extrabold' : 'text-slate-400'
                  }`}
                >
                  <span className="w-5 h-5 rounded-full bg-slate-900 text-white flex items-center justify-center text-[10px]">
                    3
                  </span>
                  Review
                </span>
              </div>

              <button onClick={() => setIsCheckoutOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Step 1: Shipping Address */}
            {checkoutStep === 1 && (
              <div className="space-y-4 text-xs">
                <h3 className="font-bold text-sm text-slate-900">Delivery Address</h3>
                <div className="space-y-3">
                  <div>
                    <label className="text-slate-500 block mb-1">Full Name</label>
                    <input
                      type="text"
                      value={shippingAddress.fullName}
                      onChange={(e) => setShippingAddress({ ...shippingAddress, fullName: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="text-slate-500 block mb-1">Street Address</label>
                    <input
                      type="text"
                      value={shippingAddress.addressLine1}
                      onChange={(e) => setShippingAddress({ ...shippingAddress, addressLine1: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-slate-500 block mb-1">City</label>
                      <input
                        type="text"
                        value={shippingAddress.city}
                        onChange={(e) => setShippingAddress({ ...shippingAddress, city: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="text-slate-500 block mb-1">Postal Code</label>
                      <input
                        type="text"
                        value={shippingAddress.postalCode}
                        onChange={(e) => setShippingAddress({ ...shippingAddress, postalCode: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg"
                      />
                    </div>
                  </div>
                </div>

                <div className="pt-3 flex justify-end">
                  <button
                    onClick={() => setCheckoutStep(2)}
                    className="px-5 py-2.5 bg-slate-900 text-white rounded-xl font-bold flex items-center gap-1.5 hover:bg-slate-800"
                  >
                    <span>Continue to Payment</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Step 2: Payment Rail - Kenyan Ecosystem */}
            {checkoutStep === 2 && (
              <div className="space-y-4 text-xs">
                <div>
                  <h3 className="font-bold text-sm text-slate-900">Select Kenyan Payment Method</h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Pay securely via Safaricom M-PESA, Airtel Money, Pesalink, or on Delivery.
                  </p>
                </div>

                <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1">
                  {/* Safaricom M-PESA STK Push */}
                  <label
                    onClick={() => setPaymentMethod('MPESA_EXPRESS')}
                    className={`p-3.5 rounded-xl border flex flex-col gap-2.5 cursor-pointer transition-all ${
                      paymentMethod === 'MPESA_EXPRESS'
                        ? 'border-emerald-600 bg-emerald-50/50 ring-1 ring-emerald-600'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-lg bg-[#00A94F] text-white flex items-center justify-center font-bold text-xs shadow-2xs">
                          M
                        </div>
                        <div>
                          <div className="font-bold text-slate-900 flex items-center gap-2">
                            <span>Lipa na M-PESA Online (STK Push)</span>
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#00A94F]/15 text-[#00A94F]">
                              Recommended
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-500">
                            Instant prompt sent to your Safaricom mobile handset. Enter PIN to pay.
                          </div>
                        </div>
                      </div>
                      <span className="font-mono text-xs font-bold text-emerald-800">Safaricom Daraja</span>
                    </div>

                    {paymentMethod === 'MPESA_EXPRESS' && (
                      <div className="pt-2 border-t border-emerald-200/60 flex items-center gap-2">
                        <span className="text-slate-600 font-semibold text-[11px]">M-PESA Number:</span>
                        <input
                          type="tel"
                          value={mpesaPhone}
                          onChange={(e) => setMpesaPhone(e.target.value)}
                          placeholder="e.g. 0752720933 or +254..."
                          className="flex-1 bg-white border border-emerald-300 rounded-lg px-2.5 py-1 text-xs font-mono font-bold text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                        />
                      </div>
                    )}
                  </label>

                  {/* M-PESA Paybill / Till Number */}
                  <label
                    onClick={() => setPaymentMethod('MPESA_PAYBILL')}
                    className={`p-3.5 rounded-xl border flex items-center justify-between cursor-pointer transition-all ${
                      paymentMethod === 'MPESA_PAYBILL'
                        ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-emerald-700 text-white flex items-center justify-center font-bold text-xs">
                        #
                      </div>
                      <div>
                        <div className="font-bold text-slate-900">M-PESA Paybill / Buy Goods Till</div>
                        <div className="text-[11px] text-slate-500">
                          Paybill: <span className="font-mono font-bold text-slate-800">247247</span> (Acc: <span className="font-mono font-bold text-slate-800">SAFARI</span>) · Till: <span className="font-mono font-bold text-slate-800">542910</span>
                        </div>
                      </div>
                    </div>
                    <span className="font-mono text-xs font-bold text-slate-600">Manual C2B</span>
                  </label>

                  {/* Airtel Money Kenya */}
                  <label
                    onClick={() => setPaymentMethod('AIRTEL_MONEY')}
                    className={`p-3.5 rounded-xl border flex items-center justify-between cursor-pointer transition-all ${
                      paymentMethod === 'AIRTEL_MONEY'
                        ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-red-600 text-white flex items-center justify-center font-bold text-xs">
                        A
                      </div>
                      <div>
                        <div className="font-bold text-slate-900">Airtel Money Kenya</div>
                        <div className="text-[11px] text-slate-500">Direct Airtel SIM mobile wallet deduction</div>
                      </div>
                    </div>
                    <span className="font-mono text-xs font-bold text-red-600">Airtel Money</span>
                  </label>

                  {/* Cash or M-PESA on Delivery */}
                  <label
                    onClick={() => setPaymentMethod('CASH_ON_DELIVERY')}
                    className={`p-3.5 rounded-xl border flex items-center justify-between cursor-pointer transition-all ${
                      paymentMethod === 'CASH_ON_DELIVERY'
                        ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-slate-800 text-white flex items-center justify-center">
                        <Truck className="w-4 h-4 text-emerald-400" />
                      </div>
                      <div>
                        <div className="font-bold text-slate-900">Cash / M-PESA on Delivery</div>
                        <div className="text-[11px] text-slate-500">
                          Hand payment to Sendy/Boda rider upon parcel receipt in Nairobi
                        </div>
                      </div>
                    </div>
                    <span className="font-mono text-xs font-bold text-slate-700">Doorstep</span>
                  </label>

                  {/* Pesalink Bank Transfer */}
                  <label
                    onClick={() => setPaymentMethod('BANK_TRANSFER')}
                    className={`p-3.5 rounded-xl border flex items-center justify-between cursor-pointer transition-all ${
                      paymentMethod === 'BANK_TRANSFER'
                        ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-blue-700 text-white flex items-center justify-center font-bold text-xs">
                        P
                      </div>
                      <div>
                        <div className="font-bold text-slate-900">Pesalink / Kenyan Bank Transfer</div>
                        <div className="text-[11px] text-slate-500">Equity Bank, KCB, NCBA, Stanbic, Co-op Bank</div>
                      </div>
                    </div>
                    <span className="font-mono text-xs font-bold text-blue-700">Pesalink</span>
                  </label>

                  {/* Card (Pesapal) */}
                  <label
                    onClick={() => setPaymentMethod('CREDIT_CARD')}
                    className={`p-3.5 rounded-xl border flex items-center justify-between cursor-pointer transition-all ${
                      paymentMethod === 'CREDIT_CARD'
                        ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-slate-700 text-white flex items-center justify-center">
                        <CreditCard className="w-4 h-4 text-white" />
                      </div>
                      <div>
                        <div className="font-bold text-slate-900">Credit / Debit Card (Pesapal Kenya)</div>
                        <div className="text-[11px] text-slate-500">Visa, Mastercard, American Express</div>
                      </div>
                    </div>
                    <span className="font-mono text-xs font-bold text-slate-900">Visa / MC</span>
                  </label>
                </div>

                <div className="pt-3 flex justify-between">
                  <button
                    onClick={() => setCheckoutStep(1)}
                    className="px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-100"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => setCheckoutStep(3)}
                    className="px-5 py-2.5 bg-slate-900 text-white rounded-xl font-bold flex items-center gap-1.5 hover:bg-slate-800"
                  >
                    <span>Review Order & eTIMS</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: Review & Place Order - KRA eTIMS & M-PESA STK Flow */}
            {checkoutStep === 3 && (
              <div className="space-y-4 text-xs">
                <div>
                  <h3 className="font-bold text-sm text-slate-900">Final Order Review & KRA eTIMS</h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Authorized orders are registered with the Kenya Revenue Authority eTIMS system.
                  </p>
                </div>

                <div className="p-3.5 bg-slate-50 rounded-xl space-y-2 border border-slate-200 font-mono">
                  <div className="flex justify-between text-slate-600">
                    <span>Subtotal:</span>
                    <span>{formatLocalPrice(pricingSummary.subtotalCents)}</span>
                  </div>
                  {pricingSummary.discountCents > 0 && (
                    <div className="flex justify-between text-emerald-700 font-bold">
                      <span>Discount ({appliedDiscount}):</span>
                      <span>-{formatLocalPrice(pricingSummary.discountCents)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-slate-500 text-[11px]">
                    <span>16% KRA VAT (eTIMS Included):</span>
                    <span>{formatLocalPrice(pricingSummary.taxCents)}</span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Shipping Carrier:</span>
                    <span className="font-sans font-semibold text-slate-800">
                      {shippingAddress.city.toLowerCase().includes('nairobi')
                        ? 'Sendy / Nairobi Boda Courier'
                        : 'Fargo Courier Kenya'}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Shipping Fee:</span>
                    <span>
                      {pricingSummary.shippingCents === 0
                        ? 'FREE'
                        : formatLocalPrice(pricingSummary.shippingCents)}
                    </span>
                  </div>
                  <div className="flex justify-between text-base font-bold text-slate-900 pt-2 border-t border-slate-200">
                    <span>Total Amount (KES):</span>
                    <span>{formatLocalPrice(pricingSummary.totalCents)}</span>
                  </div>
                </div>

                {/* KRA eTIMS Compliance Notice */}
                <div className="p-3 bg-emerald-50/70 border border-emerald-200 rounded-xl flex items-start gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                  <div className="text-[11px] text-emerald-900 leading-relaxed">
                    <span className="font-bold">KRA eTIMS Tax Compliance:</span> A sequential electronic tax invoice serial (e.g. <span className="font-mono font-semibold">eTIMS-2026-NBI-XXXXX</span>) with tax verification details will be attached to your official receipt.
                  </div>
                </div>

                {/* M-PESA STK Push Live Simulation Status */}
                {paymentMethod === 'MPESA_EXPRESS' && (
                  <div className="p-3.5 bg-slate-900 text-white rounded-xl space-y-2 border border-slate-800">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-[#00A94F] animate-pulse"></span>
                        <span className="font-bold text-xs">Safaricom Lipa na M-PESA STK Push</span>
                      </div>
                      <span className="font-mono text-[11px] text-emerald-400 font-bold">{mpesaPhone}</span>
                    </div>

                    {stkState === 'idle' && (
                      <p className="text-[11px] text-slate-300 leading-relaxed">
                        Clicking the button below will trigger an STK Push PIN prompt directly to your phone. Unlock your screen to enter your M-PESA PIN.
                      </p>
                    )}

                    {stkState === 'sending_prompt' && (
                      <div className="flex items-center gap-2 py-1 text-xs text-amber-300 animate-pulse">
                        <Clock className="w-3.5 h-3.5" />
                        <span>Sending STK prompt to {mpesaPhone} via Daraja Gateway...</span>
                      </div>
                    )}

                    {stkState === 'awaiting_pin' && (
                      <div className="flex items-center gap-2 py-1 text-xs text-emerald-300 font-semibold animate-pulse">
                        <div className="w-3.5 h-3.5 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin"></div>
                        <span>STK Push received on {mpesaPhone}! Awaiting 4-digit PIN...</span>
                      </div>
                    )}

                    {stkState === 'authorized' && (
                      <div className="flex items-center gap-2 py-1 text-xs text-emerald-400 font-bold">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>PIN Accepted · M-PESA Ref {activeReceiptCode} Confirmed!</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="pt-2 flex justify-between items-center">
                  <button
                    disabled={stkState !== 'idle'}
                    onClick={() => setCheckoutStep(2)}
                    className="px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                  >
                    Back
                  </button>
                  <button
                    disabled={stkState !== 'idle'}
                    onClick={handlePlaceOrder}
                    className="px-6 py-2.5 bg-slate-900 text-white rounded-xl font-bold flex items-center gap-2 hover:bg-slate-800 shadow-md disabled:opacity-75 disabled:cursor-wait"
                  >
                    {paymentMethod === 'MPESA_EXPRESS' ? (
                      <>
                        <span>{stkState === 'idle' ? 'Send STK Push & Pay' : 'Processing M-PESA...'}</span>
                        <ArrowRight className="w-4 h-4 text-emerald-400" />
                      </>
                    ) : (
                      <>
                        <span>Authorize & Place Order</span>
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* FLOATING AI SHOPPING CONCIERGE WIDGET */}
      <div className="fixed bottom-6 right-6 z-40">
        {!isAiConciergeOpen ? (
          <button
            onClick={() => setIsAiConciergeOpen(true)}
            className="flex items-center gap-2 px-4 py-3 bg-slate-900 text-white rounded-full shadow-2xl hover:bg-slate-800 transition-all hover:scale-105 border border-slate-700"
          >
            <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
            <span className="text-xs font-bold">Ask AI Shopping Assistant</span>
          </button>
        ) : (
          <div className="w-80 sm:w-96 bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col h-[460px] overflow-hidden animate-fade-in">
            {/* Header */}
            <div className="p-3.5 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-amber-400" />
                <span className="font-bold text-xs">SokoFlow Shopping Assistant</span>
              </div>
              <button
                onClick={() => setIsAiConciergeOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Chat Messages */}
            <div className="flex-1 overflow-y-auto p-3.5 space-y-3 text-xs">
              {aiChatMessages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex flex-col ${msg.sender === 'USER' ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-3.5 py-2 leading-relaxed ${
                      msg.sender === 'USER'
                        ? 'bg-slate-900 text-white rounded-tr-xs'
                        : 'bg-slate-100 text-slate-800 rounded-tl-xs'
                    }`}
                  >
                    {msg.text}
                  </div>

                  {msg.recommendedSku && (
                    <button
                      onClick={() => {
                        const recProduct = products.find((p) => p.sku === msg.recommendedSku);
                        if (recProduct) handleAddToCart(recProduct, msg.recommendedSku);
                      }}
                      className="mt-1.5 px-3 py-1 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-lg text-[11px] font-bold hover:bg-emerald-100 flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3 text-emerald-600" />
                      <span>Add {msg.recommendedSku} to Cart</span>
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Input */}
            <div className="p-2.5 border-t border-slate-200 flex items-center gap-1.5 bg-slate-50">
              <input
                type="text"
                value={aiChatInput}
                onChange={(e) => setAiChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSendAiMessage();
                }}
                placeholder="Ask about sizes, stock, or items..."
                className="flex-1 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
              <button
                onClick={handleSendAiMessage}
                className="p-1.5 bg-slate-900 text-white rounded-lg hover:bg-slate-800"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* OFFICIAL KRA eTIMS TAX INVOICE MODAL */}
      {invoiceModalOrder && (
        <KraTaxInvoiceModal
          order={invoiceModalOrder}
          tenant={tenant}
          onClose={() => setInvoiceModalOrder(null)}
        />
      )}
    </div>
  );
};
