import React, { useState, useEffect, useRef } from 'react';
import {
  MessageSquare,
  Search,
  Send,
  Phone,
  ExternalLink,
  CheckCheck,
  Clock,
  User,
  ShoppingBag,
  Sparkles,
  Bot,
  UserCheck,
  RefreshCw,
  Plus,
  Package,
  ArrowRight,
  Filter,
  CheckCircle2,
  AlertCircle,
  Headphones,
} from 'lucide-react';
import { InventoryStore } from '../lib/inventoryEngine.ts';
import { Order, Product, Tenant, WhatsAppMessageRecord } from '../lib/types.ts';
import { apiFetch } from '../lib/firebaseClient.ts';

interface WhatsAppChannelViewProps {
  tenant: Tenant;
  inventoryEngine: InventoryStore;
  products: Product[];
  orders: Order[];
  onOrderCreated?: (order: Order) => void;
  onNavigateToOrder?: (orderId: string) => void;
  onNavigateToSupport?: () => void;
}

interface CustomerConversation {
  phoneNumber: string;
  customerName: string;
  lastMessage: WhatsAppMessageRecord;
  messages: WhatsAppMessageRecord[];
  orderId?: string;
  unread: boolean;
  humanTakeover: boolean;
}

export const WhatsAppChannelView: React.FC<WhatsAppChannelViewProps> = ({
  tenant,
  inventoryEngine,
  products,
  orders,
  onOrderCreated,
  onNavigateToOrder,
}) => {
  const [messages, setMessages] = useState<WhatsAppMessageRecord[]>([]);
  const [selectedCustomerPhone, setSelectedCustomerPhone] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [isSendingReply, setIsSendingReply] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'ALL' | 'ORDERS' | 'SUPPORT'>('ALL');
  const [isSimulatingInbound, setIsSimulatingInbound] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [humanTakeoverPhones, setHumanTakeoverPhones] = useState<Set<string>>(new Set());

  const chatScrollContainerRef = useRef<HTMLDivElement>(null);
  const prevCustomerPhoneRef = useRef<string | null>(null);
  const prevMessagesCountRef = useRef<number>(0);

  // Helper to scroll ONLY the chat messages container without scrolling the browser window
  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const el = chatScrollContainerRef.current;
    if (el) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior,
      });
    }
  };

  // 1. Fetch live messages from backend server
  const fetchMessages = async () => {
    try {
      const response = await apiFetch('/api/whatsapp/messages');
      if (!response.ok) throw new Error(`Loading WhatsApp messages failed (HTTP ${response.status}).`);
      const res = await response.json();
      if (res?.messages && Array.isArray(res.messages)) {
        setMessages((prev) => {
          // If message count and last message are identical, keep existing reference to prevent re-renders
          if (
            prev.length === res.messages.length &&
            prev[prev.length - 1]?.id === res.messages[res.messages.length - 1]?.id &&
            prev[prev.length - 1]?.status === res.messages[res.messages.length - 1]?.status
          ) {
            return prev;
          }
          return res.messages;
        });
      }
    } catch (error) {
      console.error('Loading WhatsApp messages failed:', error);
    }
  };

  useEffect(() => {
    fetchMessages();

    // Auto-poll messages every 3s for real-time customer updates
    const pollInterval = setInterval(() => {
      fetchMessages();
    }, 3000);

    return () => clearInterval(pollInterval);
  }, []);

  // 2. Group messages into customer conversations
  const conversationsMap = new Map<string, CustomerConversation>();

  // Ensure Sarah Jenkins initial conversation exists if no messages yet
  const allMessages = messages.length > 0 ? messages : [];

  for (const msg of allMessages) {
    const customerPhone = msg.direction === 'INBOUND' ? msg.fromNumber : msg.toNumber;
    if (!customerPhone) continue;

    if (!conversationsMap.has(customerPhone)) {
      conversationsMap.set(customerPhone, {
        phoneNumber: customerPhone,
        customerName: msg.customerName || 'Customer',
        lastMessage: msg,
        messages: [msg],
        orderId: msg.orderId,
        unread: false,
        humanTakeover: false,
      });
    } else {
      const conv = conversationsMap.get(customerPhone)!;
      conv.messages.push(msg);
      if (new Date(msg.timestamp) > new Date(conv.lastMessage.timestamp)) {
        conv.lastMessage = msg;
        if (msg.orderId) conv.orderId = msg.orderId;
        if (msg.customerName && msg.customerName !== 'Customer') {
          conv.customerName = msg.customerName;
        }
      }
    }
  }

  // Convert map to sorted array (most recent first)
  const conversations = Array.from(conversationsMap.values()).sort(
    (a, b) => new Date(b.lastMessage.timestamp).getTime() - new Date(a.lastMessage.timestamp).getTime()
  );

  // Auto-select first conversation if none selected
  useEffect(() => {
    if (!selectedCustomerPhone && conversations.length > 0) {
      setSelectedCustomerPhone(conversations[0].phoneNumber);
    }
  }, [conversations.length, selectedCustomerPhone]);

  // Scroll to bottom ONLY when switching conversations
  useEffect(() => {
    if (selectedCustomerPhone && selectedCustomerPhone !== prevCustomerPhoneRef.current) {
      prevCustomerPhoneRef.current = selectedCustomerPhone;
      setIsScrolledUp(false);
      // Small timeout ensures DOM elements have rendered
      const timer = setTimeout(() => {
        scrollToBottom('auto');
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [selectedCustomerPhone]);

  // When new messages arrive, ONLY auto-scroll down if user is NOT currently scrolled up reading history
  useEffect(() => {
    if (messages.length > prevMessagesCountRef.current) {
      prevMessagesCountRef.current = messages.length;
      if (!isScrolledUp) {
        scrollToBottom('smooth');
      }
    }
  }, [messages.length, isScrolledUp]);

  // Handle user scroll inside the chat feed
  const handleFeedScroll = () => {
    const el = chatScrollContainerRef.current;
    if (!el) return;
    // Check if user is more than 80px from bottom
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsScrolledUp(distanceFromBottom > 80);
  };

  const activeConversation = conversations.find((c) => c.phoneNumber === selectedCustomerPhone);

  // Filter conversations based on search and tab
  const filteredConversations = conversations.filter((c) => {
    const matchesSearch =
      c.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.phoneNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.lastMessage.textBody.toLowerCase().includes(searchQuery.toLowerCase());

    if (!matchesSearch) return false;

    if (filterType === 'ORDERS') {
      return Boolean(c.orderId);
    }
    if (filterType === 'SUPPORT') {
      return c.lastMessage.textBody.toLowerCase().includes('agent') || c.lastMessage.textBody.toLowerCase().includes('support');
    }
    return true;
  });

  // 3. Send direct agent reply to customer
  const handleSendReply = async (textToSend?: string) => {
    const text = (textToSend || replyText).trim();
    if (!text || !activeConversation || isSendingReply) return;

    setIsSendingReply(true);
    setReplyText('');

    try {
      const response = await apiFetch('/api/whatsapp/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toNumber: activeConversation.phoneNumber,
          customerName: activeConversation.customerName,
          textBody: text,
          orderId: activeConversation.orderId,
        }),
      });
      const res = await response.json();
      if (!response.ok) throw new Error(res?.error || `Sending WhatsApp reply failed (HTTP ${response.status}).`);

      if (res?.success && res.message) {
        setMessages((prev) => [...prev, res.message]);
      }
    } catch (error) {
      console.error('Sending WhatsApp reply failed:', error);
    } finally {
      setIsSendingReply(false);
      setIsScrolledUp(false);
      setTimeout(() => scrollToBottom('smooth'), 50);
      fetchMessages();
    }
  };

  // 4. Simulate an incoming customer message to easily test real-time chat flow
  const handleSimulateInboundCustomerMessage = async (customText?: string) => {
    setIsSimulatingInbound(true);

    const sampleQuestions = [
      'Jambo! Do you have the Safari Trail T-Shirt in stock?',
      'Can I order 2 units of TSHIRT001 to Westlands Nairobi?',
      'What are your Boda delivery rates across Nairobi and upcountry?',
      'I want to buy JKT-ALPINE-09 for Mt. Kenya hike. Is Medium available?',
      'What is your Lipa na M-PESA Till or Paybill number?',
    ];
    const text = customText || sampleQuestions[Math.floor(Math.random() * sampleQuestions.length)];

    try {
      const response = await apiFetch('/api/web-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const res = await response.json();
      if (!response.ok) throw new Error(res?.error || `Test message failed (HTTP ${response.status}).`);

      if (res?.orderCreatedId && onOrderCreated) {
        const matchingOrder = orders.find((o) => o.id === res.orderCreatedId);
        if (matchingOrder) onOrderCreated(matchingOrder);
      }

      await fetchMessages();
      setSelectedCustomerPhone(res.fromNumber);
      setIsScrolledUp(false);
      setTimeout(() => scrollToBottom('smooth'), 80);
    } catch (error) {
      console.error('Simulated inbound message failed:', error);
    } finally {
      setIsSimulatingInbound(false);
    }
  };

  const cleanActivePhone = activeConversation?.phoneNumber.replace(/\D/g, '') || '';
  const directWhatsAppUrl = `https://wa.me/${cleanActivePhone}`;

  return (
    <div className="space-y-4">
      {/* 1. Header: Customer Chats Hub */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-[#25D366]/10 text-[#25D366] flex items-center justify-center border border-[#25D366]/20">
            <MessageSquare className="w-5 h-5 fill-[#25D366]/20" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-slate-900">
                WhatsApp Customer Chats
              </h1>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>Live Inbox</span>
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Live customer orders, automated stock queries, and direct agent replies.
            </p>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleSimulateInboundCustomerMessage()}
            disabled={isSimulatingInbound}
            className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-xl text-xs font-semibold transition-all shadow-2xs flex items-center gap-1.5"
            title="Simulate an incoming WhatsApp customer message"
          >
            {isSimulatingInbound ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5" />
            )}
            <span>Test Inbound Customer Message</span>
          </button>

          <button
            onClick={() => fetchMessages()}
            className="p-2 border border-slate-200 bg-slate-50 hover:bg-slate-100 rounded-xl text-slate-600 transition-colors"
            title="Refresh Chats"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 2. Main 2-Column WhatsApp Chat Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden h-[720px]">
        {/* Left Column: Conversations List (4 cols) */}
        <div className="lg:col-span-4 border-r border-slate-200 flex flex-col bg-slate-50/60 h-full">
          {/* Search & Filters */}
          <div className="p-3.5 border-b border-slate-200 bg-white space-y-2.5">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name, phone, or text..."
                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
              <button
                onClick={() => setFilterType('ALL')}
                className={`px-3 py-1 rounded-lg transition-colors ${
                  filterType === 'ALL'
                    ? 'bg-slate-900 text-white font-bold'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                }`}
              >
                All ({conversations.length})
              </button>
              <button
                onClick={() => setFilterType('ORDERS')}
                className={`px-3 py-1 rounded-lg transition-colors ${
                  filterType === 'ORDERS'
                    ? 'bg-emerald-600 text-white font-bold'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                }`}
              >
                Orders ({conversations.filter((c) => c.orderId).length})
              </button>
              <button
                onClick={() => setFilterType('SUPPORT')}
                className={`px-3 py-1 rounded-lg transition-colors ${
                  filterType === 'SUPPORT'
                    ? 'bg-amber-600 text-white font-bold'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                }`}
              >
                Support
              </button>
            </div>
          </div>

          {/* Conversations Scroll Area */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {filteredConversations.length === 0 ? (
              <div className="text-center py-16 px-4 space-y-3">
                <div className="w-12 h-12 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
                  <MessageSquare className="w-6 h-6" />
                </div>
                <div>
                  <div className="text-xs font-bold text-slate-700">No chats found</div>
                  <div className="text-[11px] text-slate-400 mt-1">
                    Click "Test Inbound Customer Message" above to simulate an incoming customer inquiry.
                  </div>
                </div>
              </div>
            ) : (
              filteredConversations.map((conv) => {
                const isSelected = conv.phoneNumber === selectedCustomerPhone;
                const formattedTime = new Date(conv.lastMessage.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                });

                return (
                  <div
                    key={conv.phoneNumber}
                    onClick={() => setSelectedCustomerPhone(conv.phoneNumber)}
                    className={`p-3.5 flex items-start gap-3 cursor-pointer transition-colors border-l-4 ${
                      isSelected
                        ? 'bg-white border-l-[#25D366] shadow-2xs'
                        : 'hover:bg-slate-100/70 border-l-transparent'
                    }`}
                  >
                    {/* Avatar */}
                    <div className="w-10 h-10 rounded-full bg-slate-200 text-slate-700 font-bold flex items-center justify-center shrink-0 text-sm border border-slate-300/60">
                      {conv.customerName.charAt(0) || <User className="w-5 h-5" />}
                    </div>

                    {/* Meta & Snippet */}
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-xs text-slate-900 truncate">
                          {conv.customerName}
                        </h4>
                        <span className="text-[10px] text-slate-400 font-mono shrink-0">
                          {formattedTime}
                        </span>
                      </div>

                      <div className="text-[11px] text-slate-500 font-mono truncate">
                        {conv.phoneNumber}
                      </div>

                      <p className="text-xs text-slate-600 line-clamp-1 leading-snug">
                        {conv.lastMessage.direction === 'OUTBOUND' && (
                          <span className="text-slate-400 mr-1 font-medium">You:</span>
                        )}
                        {conv.lastMessage.textBody}
                      </p>

                      {/* Badges */}
                      <div className="flex items-center gap-1.5 pt-0.5">
                        {conv.orderId && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 font-mono text-[9.5px] font-bold border border-emerald-200">
                            <ShoppingBag className="w-3 h-3" />
                            <span>{conv.orderId}</span>
                          </span>
                        )}
                        {conv.messages.length > 1 && (
                          <span className="text-[9.5px] text-slate-400 font-mono">
                            {conv.messages.length} msgs
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Active Conversation Stream (8 cols) */}
        <div className="lg:col-span-8 flex flex-col h-full bg-[#EFEAE2]">
          {activeConversation ? (
            <>
              {/* Active Chat Header */}
              <div className="px-5 py-3.5 bg-white border-b border-slate-200 flex items-center justify-between shrink-0 shadow-2xs">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-slate-900 text-white font-bold flex items-center justify-center text-sm shadow-sm">
                    {activeConversation.customerName.charAt(0)}
                  </div>
                  <div>
                    <div className="font-bold text-sm text-slate-900 flex items-center gap-2">
                      <span>{activeConversation.customerName}</span>
                      <span className="text-[10px] text-emerald-700 font-mono bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full font-semibold">
                        WhatsApp Active
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 font-mono">
                      {activeConversation.phoneNumber}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Human Takeover Toggle */}
                  <button
                    onClick={() => {
                      setHumanTakeoverPhones((prev) => {
                        const next = new Set(prev);
                        if (next.has(activeConversation.phoneNumber)) {
                          next.delete(activeConversation.phoneNumber);
                        } else {
                          next.add(activeConversation.phoneNumber);
                        }
                        return next;
                      });
                    }}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 border ${
                      humanTakeoverPhones.has(activeConversation.phoneNumber)
                        ? 'bg-amber-100 border-amber-300 text-amber-900 shadow-2xs'
                        : 'bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-700'
                    }`}
                    title="Take over conversation (pauses automated AI bot)"
                  >
                    <Headphones className="w-3.5 h-3.5" />
                    <span>
                      {humanTakeoverPhones.has(activeConversation.phoneNumber)
                        ? 'Agent Live (AI Paused)'
                        : 'Take Over (Live Agent)'}
                    </span>
                  </button>

                  {/* Linked Order Button */}
                  {activeConversation.orderId && (
                    <button
                      onClick={() => onNavigateToOrder && onNavigateToOrder(activeConversation.orderId!)}
                      className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5"
                    >
                      <ShoppingBag className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Order {activeConversation.orderId}</span>
                      <ArrowRight className="w-3 h-3 text-emerald-600" />
                    </button>
                  )}

                  {/* Open in WhatsApp App */}
                  <a
                    href={directWhatsAppUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="p-2 border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-600 transition-colors"
                    title="Open in WhatsApp Web"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                </div>
              </div>

              {/* Message History Feed */}
              <div
                ref={chatScrollContainerRef}
                onScroll={handleFeedScroll}
                className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-3.5 relative"
                style={{
                  backgroundImage: 'radial-gradient(rgba(0,0,0,0.035) 1px, transparent 0)',
                  backgroundSize: '16px 16px',
                }}
              >
                {/* Security encryption pill */}
                <div className="text-center">
                  <span className="inline-block bg-[#FFF9C4]/90 text-amber-900 border border-amber-200/90 text-[10.5px] px-3.5 py-1 rounded-lg shadow-2xs font-medium">
                    🔒 Messages are end-to-end encrypted via official WhatsApp Cloud API.
                  </span>
                </div>

                {activeConversation.messages.map((m) => {
                  const isOutbound = m.direction === 'OUTBOUND';
                  const time = new Date(m.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  });

                  return (
                    <div
                      key={m.id}
                      className={`flex flex-col ${isOutbound ? 'items-end' : 'items-start'}`}
                    >
                      <div
                        className={`max-w-[85%] sm:max-w-[70%] rounded-2xl px-4 py-2.5 text-xs shadow-2xs leading-relaxed whitespace-pre-line relative ${
                          isOutbound
                            ? 'bg-[#DCF8C6] text-slate-900 rounded-tr-xs'
                            : 'bg-white text-slate-900 rounded-tl-xs border border-slate-100 shadow-sm'
                        }`}
                      >
                        {/* Body text */}
                        <div>{m.textBody}</div>

                        {/* Order created badge if message triggered order */}
                        {m.orderId && (
                          <div className="mt-2 pt-2 border-t border-emerald-600/20 flex items-center justify-between text-[11px] font-bold text-emerald-800">
                            <span className="flex items-center gap-1">
                              <Package className="w-3.5 h-3.5 text-emerald-700" />
                              <span>Order Placed: {m.orderId}</span>
                            </span>
                            {onNavigateToOrder && (
                              <button
                                onClick={() => onNavigateToOrder(m.orderId!)}
                                className="underline hover:text-emerald-950 font-semibold"
                              >
                                View Order
                              </button>
                            )}
                          </div>
                        )}

                        {/* Tool call indicator */}
                        {m.toolUsed && (
                          <div className="mt-1.5 flex items-center gap-1 text-[10px] text-slate-500 font-mono">
                            <Bot className="w-3 h-3 text-emerald-600" />
                            <span>Action: {m.toolUsed}</span>
                          </div>
                        )}

                        {/* Timestamp & double checkmarks */}
                        <div className="flex items-center justify-end gap-1 mt-1 text-[9.5px] text-slate-400 font-mono">
                          <span>{time}</span>
                          {isOutbound && (
                            <CheckCheck className="w-3.5 h-3.5 text-sky-500" />
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Floating "Jump to latest" button when scrolled up */}
                {isScrolledUp && (
                  <div className="sticky bottom-2 flex justify-center pointer-events-none">
                    <button
                      onClick={() => scrollToBottom('smooth')}
                      className="pointer-events-auto bg-slate-900/90 hover:bg-slate-900 text-white text-[11px] font-semibold px-3 py-1.5 rounded-full shadow-lg flex items-center gap-1.5 transition-all"
                    >
                      <span>↓ Jump to latest</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Quick Reply Chips */}
              <div className="px-4 py-2 bg-slate-50 border-t border-slate-200 flex items-center gap-2 overflow-x-auto no-scrollbar text-xs">
                <span className="text-[11px] font-semibold text-slate-400 shrink-0">Quick replies:</span>
                <button
                  onClick={() => handleSendReply('Your order has been confirmed and packed! 🚚')}
                  className="shrink-0 px-2.5 py-1 bg-white hover:bg-slate-100 border border-slate-200 rounded-full text-slate-700 text-[11px] transition-colors"
                >
                  🚚 Order Packed
                </button>
                <button
                  onClick={() => handleSendReply('Thank you for shopping with us! Have a wonderful day! 😊')}
                  className="shrink-0 px-2.5 py-1 bg-white hover:bg-slate-100 border border-slate-200 rounded-full text-slate-700 text-[11px] transition-colors"
                >
                  😊 Thank You
                </button>
                <button
                  onClick={() =>
                    handleSendReply(
                      'Here is our latest catalogue: TSHIRT001 (Merino T-Shirt, $48), JKT-ALPINE-09 (Alpine Jacket, $245).'
                    )
                  }
                  className="shrink-0 px-2.5 py-1 bg-white hover:bg-slate-100 border border-slate-200 rounded-full text-slate-700 text-[11px] transition-colors"
                >
                  🛍️ Share Catalog
                </button>
                <button
                  onClick={() =>
                    handleSendReply('Let me check our warehouse live stock right now for you! 📦')
                  }
                  className="shrink-0 px-2.5 py-1 bg-white hover:bg-slate-100 border border-slate-200 rounded-full text-slate-700 text-[11px] transition-colors"
                >
                  📦 Check Stock
                </button>
              </div>

              {/* Support Agent Reply Console Header */}
              <div className="px-4 py-2 bg-slate-900 text-white flex items-center justify-between text-xs border-t border-slate-800">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="font-semibold text-slate-100">Live Support Agent Console:</span>
                  <span className="text-slate-300">
                    Replying directly to <strong>{activeConversation.customerName}</strong> ({activeConversation.phoneNumber})
                  </span>
                </div>
                <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full font-mono font-bold">
                  Official WhatsApp Delivery
                </span>
              </div>

              {/* Message Input Box */}
              <div className="p-3.5 bg-white border-t border-slate-200 flex items-center gap-2">
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSendReply();
                    }
                  }}
                  placeholder={`Reply to ${activeConversation.customerName} on WhatsApp...`}
                  className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-emerald-500"
                />
                <button
                  onClick={() => handleSendReply()}
                  disabled={!replyText.trim() || isSendingReply}
                  className="px-5 py-2.5 bg-[#25D366] hover:bg-[#20bd5a] disabled:opacity-40 text-slate-950 font-bold rounded-xl text-xs transition-all shadow-2xs flex items-center gap-1.5"
                >
                  {isSendingReply ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                  <span>Send</span>
                </button>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3">
              <div className="w-16 h-16 rounded-3xl bg-slate-200/60 text-slate-400 flex items-center justify-center">
                <MessageSquare className="w-8 h-8" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-slate-700">No Conversation Selected</h3>
                <p className="text-xs text-slate-400 mt-1 max-w-sm">
                  Select a customer chat from the left column to view message history, track orders, or reply directly.
                </p>
              </div>
              <button
                onClick={() => handleSimulateInboundCustomerMessage()}
                className="mt-2 px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-semibold hover:bg-slate-800 transition-colors"
              >
                Start a Sample WhatsApp Conversation
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
