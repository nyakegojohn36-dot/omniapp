import React, { useState, useRef, useEffect } from 'react';
import {
  MessageCircle,
  X,
  Send,
  ExternalLink,
  Bot,
  Sparkles,
  ShoppingBag,
  ArrowRight,
  CheckCircle2,
  Clock,
  ShieldCheck,
  Phone,
} from 'lucide-react';
import { InventoryStore } from '../lib/inventoryEngine.ts';
import { Order, Product, Tenant, WarehouseInventory } from '../lib/types.ts';

interface EmbeddedWhatsAppWidgetProps {
  tenant: Tenant;
  products: Product[];
  inventories: WarehouseInventory[];
  inventoryEngine: InventoryStore;
  displayPhoneNumber?: string;
  onOrderCreated?: (newOrder: Order) => void;
  onNavigateTab?: (tab: string) => void;
}

interface ChatMessage {
  id: string;
  sender: 'CUSTOMER' | 'BOT';
  text: string;
  timestamp: string;
  toolUsed?: string;
}

export function EmbeddedWhatsAppWidget({
  tenant,
  products,
  inventoryEngine,
  displayPhoneNumber = 'WhatsApp Commerce',
  onOrderCreated,
  onNavigateTab,
}: EmbeddedWhatsAppWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'msg-welcome',
      sender: 'BOT',
      text: `👋 Hello! Welcome to *${tenant.name}* on WhatsApp.\n\nI am your live automated shopping assistant. You can check stock, browse products, or place an order right here.\n\nTry asking:\n• *"What jackets do you have in stock?"*\n• *"Show me the catalogue"*\n• *"BUY TSHIRT001 2"*`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const cleanPhone = displayPhoneNumber.replace(/\D/g, '');
  const directWhatsAppUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(
    'Hi OmniCommerce AI! I am interested in ordering from your store.'
  )}`;

  useEffect(() => {
    if (isOpen && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  const handleSendMessage = async (textToSend?: string) => {
    const body = (textToSend || inputText).trim();
    if (!body || isTyping) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      sender: 'CUSTOMER',
      text: body,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputText('');
    setIsTyping(true);

    try {
      // Send directly to full-stack backend WhatsApp webhook endpoint
      const res = await fetch('/api/whatsapp/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          object: 'whatsapp_business_account',
          entry: [
            {
              id: '1402546412031884',
              changes: [
                {
                  value: {
                    messaging_product: 'whatsapp',
                    metadata: {
                      display_phone_number: displayPhoneNumber,
                      phone_number_id: '1386130241256254',
                    },
                    contacts: [
                      {
                        profile: { name: 'Storefront Visitor' },
                        wa_id: cleanPhone,
                      },
                    ],
                    messages: [
                      {
                        from: cleanPhone,
                        id: `wamid.widget.${Date.now()}`,
                        timestamp: `${Math.floor(Date.now() / 1000)}`,
                        text: { body },
                        type: 'text',
                      },
                    ],
                  },
                  field: 'messages',
                },
              ],
            },
          ],
        }),
      });

      const data = await res.json();
      const replyText =
        data?.reply ||
        `Thanks for your message! Our store bot is processing your request. Type *CATALOGUE* to see current items.`;

      const botMsg: ChatMessage = {
        id: `bot-${Date.now()}`,
        sender: 'BOT',
        text: replyText,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        toolUsed: data?.toolUsed,
      };

      setMessages((prev) => [...prev, botMsg]);

      // If an order was created, notify parent component & sync orders
      if (data?.orderCreatedId && onOrderCreated) {
        fetch('/api/orders')
          .then((r) => r.json())
          .then((d) => {
            if (d?.orders && Array.isArray(d.orders)) {
              const created = d.orders.find((o: any) => o.id === data.orderCreatedId);
              if (created) {
                onOrderCreated(created);
              }
            }
          })
          .catch(() => {});
      }
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: `bot-err-${Date.now()}`,
        sender: 'BOT',
        text: `⚠️ Network connection interrupted. Please try again or open our direct WhatsApp chat.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <>
      {/* Floating Trigger Button */}
      <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3">
        {!isOpen && (
          <div
            onClick={() => setIsOpen(true)}
            className="hidden sm:flex items-center gap-2 bg-white/95 backdrop-blur-md px-3.5 py-2 rounded-full shadow-lg border border-slate-200 text-xs font-semibold text-slate-800 cursor-pointer hover:bg-slate-50 transition-all hover:scale-105"
          >
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Chat on WhatsApp</span>
            <span className="text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full font-mono">
              Live
            </span>
          </div>
        )}

        <button
          onClick={() => setIsOpen(!isOpen)}
          aria-label="Toggle WhatsApp Chat"
          className="w-14 h-14 rounded-full bg-[#25D366] text-white shadow-xl hover:bg-[#20bd5a] hover:scale-105 active:scale-95 transition-all flex items-center justify-center relative group"
        >
          {isOpen ? (
            <X className="w-6 h-6 transition-transform group-hover:rotate-90 duration-200" />
          ) : (
            <>
              <MessageCircle className="w-7 h-7 fill-white/20 stroke-[2.2]" />
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-400 border-2 border-white rounded-full animate-ping" />
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 border-2 border-white rounded-full" />
            </>
          )}
        </button>
      </div>

      {/* Floating Embedded WhatsApp Chat Window */}
      {isOpen && (
        <div className="fixed bottom-24 right-6 z-50 w-[360px] sm:w-[400px] h-[540px] max-h-[80vh] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-200">
          {/* Header */}
          <div className="bg-[#075E54] text-white px-4 py-3.5 flex items-center justify-between shrink-0 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center text-white font-bold border border-white/30 text-sm">
                  🛍️
                </div>
                <span className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-400 border-2 border-[#075E54] rounded-full" />
              </div>
              <div>
                <div className="font-bold text-sm flex items-center gap-1.5 leading-tight">
                  <span>{tenant.name}</span>
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-300" />
                </div>
                <div className="text-[11px] text-emerald-100 flex items-center gap-1 font-mono">
                  <span>{displayPhoneNumber}</span>
                  <span>•</span>
                  <span className="text-emerald-300">Online</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <a
                href={directWhatsAppUrl}
                target="_blank"
                rel="noreferrer"
                title="Open in WhatsApp Web / App"
                className="p-1.5 rounded-lg hover:bg-white/10 text-emerald-100 hover:text-white transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 rounded-lg hover:bg-white/10 text-emerald-100 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Quick Direct Link Bar */}
          <div className="bg-[#128C7E] px-3 py-1.5 flex items-center justify-between text-[11px] text-white/95">
            <span className="flex items-center gap-1.5">
              <Phone className="w-3 h-3" />
              <span>Official WhatsApp Business Bot</span>
            </span>
            <a
              href={directWhatsAppUrl}
              target="_blank"
              rel="noreferrer"
              className="underline font-semibold hover:text-white flex items-center gap-0.5"
            >
              Open App <ArrowRight className="w-3 h-3" />
            </a>
          </div>

          {/* Message Area */}
          <div
            ref={chatScrollRef}
            className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#E5DDD5]/50"
            style={{
              backgroundImage:
                'radial-gradient(rgba(0,0,0,0.04) 1px, transparent 0)',
              backgroundSize: '16px 16px',
            }}
          >
            {/* Security Notice */}
            <div className="text-center">
              <span className="inline-block bg-[#FFF9C4] text-amber-900 border border-amber-200/80 text-[10px] px-3 py-1 rounded-lg shadow-2xs font-medium">
                🔒 End-to-end encrypted AI conversation with live warehouse stock
              </span>
            </div>

            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.sender === 'CUSTOMER' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 shadow-2xs text-xs leading-relaxed whitespace-pre-line ${
                    m.sender === 'CUSTOMER'
                      ? 'bg-[#DCF8C6] text-slate-900 rounded-tr-xs'
                      : 'bg-white text-slate-800 rounded-tl-xs border border-slate-100'
                  }`}
                >
                  <div>{m.text}</div>
                  <div className="flex items-center justify-end gap-1 mt-1 text-[9.5px] text-slate-400 font-mono">
                    <span>{m.timestamp}</span>
                    {m.sender === 'CUSTOMER' && <span className="text-sky-500 font-bold">✓✓</span>}
                  </div>
                </div>
              </div>
            ))}

            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-white rounded-2xl rounded-tl-xs px-3.5 py-2 text-xs text-slate-500 shadow-2xs border border-slate-100 flex items-center gap-1.5">
                  <Bot className="w-3.5 h-3.5 text-emerald-600 animate-spin" />
                  <span>Checking catalog & typing...</span>
                </div>
              </div>
            )}
          </div>

          {/* Suggested Quick Prompts */}
          <div className="px-3 py-2 bg-slate-50 border-t border-slate-200 flex items-center gap-1.5 overflow-x-auto no-scrollbar text-[11px]">
            <button
              onClick={() => handleSendMessage('What products are available?')}
              className="shrink-0 px-2.5 py-1 bg-white border border-slate-200 rounded-full hover:bg-slate-100 text-slate-700 transition-colors"
            >
              🛍️ All Products
            </button>
            <button
              onClick={() => handleSendMessage('BUY TSHIRT001 1')}
              className="shrink-0 px-2.5 py-1 bg-white border border-slate-200 rounded-full hover:bg-slate-100 text-slate-700 transition-colors"
            >
              🛒 Order T-Shirt
            </button>
            <button
              onClick={() => handleSendMessage('TRACK ORD-000008')}
              className="shrink-0 px-2.5 py-1 bg-white border border-slate-200 rounded-full hover:bg-slate-100 text-slate-700 transition-colors"
            >
              📦 Track Order
            </button>
          </div>

          {/* Input Box */}
          <div className="p-3 bg-white border-t border-slate-200 flex items-center gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about products, orders, or stock..."
              className="flex-1 bg-slate-100 border border-slate-200 rounded-xl px-3.5 py-2 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <button
              onClick={() => handleSendMessage()}
              disabled={!inputText.trim() || isTyping}
              className="p-2.5 rounded-xl bg-[#25D366] hover:bg-[#20bd5a] text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-2xs"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
