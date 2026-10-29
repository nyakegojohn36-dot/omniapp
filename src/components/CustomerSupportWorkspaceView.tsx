import React, { useState, useEffect } from 'react';
import {
  MessageSquare,
  Search,
  Send,
  Sparkles,
  User,
  Shield,
  Clock,
  CheckCircle2,
  AlertCircle,
  Package,
  RotateCcw,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  Filter,
  DollarSign,
  Phone,
  Mail,
  MapPin,
  FileText,
} from 'lucide-react';
import { CustomerProfile, Order, Product, SupportCase, Tenant, UserRole, WarehouseInventory } from '../lib/types.ts';
import { SEED_CUSTOMER_PROFILES, SEED_SUPPORT_CASES } from '../lib/sampleData.ts';
import { formatCurrency } from '../lib/pricingEngine.ts';
import { KraTaxInvoiceModal } from './KraTaxInvoiceModal.tsx';

interface CustomerSupportWorkspaceViewProps {
  tenant: Tenant;
  orders: Order[];
  products: Product[];
  inventories: WarehouseInventory[];
  currentRole: UserRole;
  onUpdateOrder?: (order: Order) => void;
}

export const CustomerSupportWorkspaceView: React.FC<CustomerSupportWorkspaceViewProps> = ({
  tenant,
  orders,
  products,
  inventories,
  currentRole,
  onUpdateOrder,
}) => {
  const [cases, setCases] = useState<SupportCase[]>(SEED_SUPPORT_CASES);
  const [activeCaseId, setActiveCaseId] = useState<string>(cases[0]?.id || 'CAS-401');
  const [activeChannel, setActiveChannel] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [replyText, setReplyText] = useState<string>('');
  const [isSendingReply, setIsSendingReply] = useState<boolean>(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [showInvoiceModal, setShowInvoiceModal] = useState<boolean>(false);

  // Instant Stock Check Tool in Support Panel
  const [stockSearchQuery, setStockSearchQuery] = useState<string>('');

  const activeCase = cases.find((c) => c.id === activeCaseId) || cases[0];
  const activeCustomer =
    SEED_CUSTOMER_PROFILES.find((p) => p.id === activeCase?.customerId) || SEED_CUSTOMER_PROFILES[0];
  const matchingOrder = orders.find((o) => o.id === activeCase?.orderId);

  const [composerTab, setComposerTab] = useState<'REPLY' | 'INTERNAL_NOTE'>('REPLY');
  const [internalNoteText, setInternalNoteText] = useState<string>('');

  // 1. Sync live customer WhatsApp messages into the Support Inbox in real time
  useEffect(() => {
    const fetchWhatsAppMessages = async () => {
      try {
        const res = await fetch('/api/whatsapp/messages').then((r) => r.json());
        if (res?.messages && Array.isArray(res.messages) && res.messages.length > 0) {
          const phoneGroups = new Map<string, any[]>();
          for (const msg of res.messages) {
            const phone = msg.direction === 'INBOUND' ? msg.fromNumber : msg.toNumber;
            if (!phone) continue;
            if (!phoneGroups.has(phone)) phoneGroups.set(phone, []);
            phoneGroups.get(phone)!.push(msg);
          }

          setCases((prevCases) => {
            const updatedCases = [...prevCases];
            phoneGroups.forEach((msgs, phone) => {
              const customerName = msgs[0]?.customerName || 'WhatsApp Customer';
              const latestMsg = msgs[msgs.length - 1];
              const linkedOrder = msgs.find((m) => m.orderId)?.orderId;
              const existingIdx = updatedCases.findIndex(
                (c) => c.customerPhone === phone || c.customerName === customerName
              );

              const formattedMessages = msgs.map((m) => ({
                sender: (m.direction === 'INBOUND'
                  ? 'CUSTOMER'
                  : m.toolUsed === 'agent_chat_reply'
                  ? 'STAFF'
                  : 'AI_ASSISTANT') as any,
                text: m.textBody,
                timestamp: m.timestamp,
                status: (m.status || 'DELIVERED') as any,
              }));

              if (existingIdx >= 0) {
                if (formattedMessages.length > updatedCases[existingIdx].messages.length) {
                  updatedCases[existingIdx] = {
                    ...updatedCases[existingIdx],
                    messages: formattedMessages,
                    orderId: linkedOrder || updatedCases[existingIdx].orderId,
                    customerPhone: phone,
                  };
                }
              } else {
                updatedCases.push({
                  id: `CAS-WA-${phone.replace(/\D/g, '').slice(-4)}`,
                  tenantId: tenant.id,
                  customerId: `cust-wa-${phone.replace(/\D/g, '')}`,
                  customerName,
                  customerEmail: `${customerName.toLowerCase().replace(/\s+/g, '.')}@whatsapp.user`,
                  customerPhone: phone,
                  channel: 'WHATSAPP',
                  orderId: linkedOrder,
                  subject: `WhatsApp customer inquiry: "${latestMsg?.textBody.slice(0, 30)}..."`,
                  status: 'OPEN',
                  priority: linkedOrder ? 'HIGH' : 'MEDIUM',
                  assignedStaffId: 'staff-supp-01',
                  handledByAi: true,
                  humanTakeover: false,
                  createdAt: msgs[0]?.timestamp || new Date().toISOString(),
                  messages: formattedMessages,
                });
              }
            });
            return updatedCases;
          });
        }
      } catch {
        // ignore
      }
    };

    fetchWhatsAppMessages();
    const pollInterval = setInterval(fetchWhatsAppMessages, 3500);
    return () => clearInterval(pollInterval);
  }, [tenant.id]);

  // Filtered cases
  const filteredCases = cases.filter((c) => {
    if (activeChannel === 'WhatsApp' && c.channel !== 'WHATSAPP') return false;
    if (activeChannel === 'Web Chat' && c.channel !== 'WEB') return false;
    if (activeChannel === 'Email' && c.channel !== 'EMAIL') return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        c.id.toLowerCase().includes(q) ||
        (c.customerName || c.customerEmail).toLowerCase().includes(q) ||
        c.subject.toLowerCase().includes(q) ||
        (c.orderId && c.orderId.toLowerCase().includes(q))
      );
    }
    return true;
  });

  // 2. Dispatch real outbound reply from Support Agent to customer
  const handleSendReply = async (textToSend?: string) => {
    const text = (textToSend || replyText).trim();
    if (!text || !activeCase || isSendingReply) return;

    setIsSendingReply(true);

    const newMessage = {
      sender: 'STAFF' as const,
      text,
      timestamp: new Date().toISOString(),
    };

    setCases((prev) =>
      prev.map((c) =>
        c.id === activeCase.id
          ? {
              ...c,
              status: 'IN_PROGRESS',
              messages: [...c.messages, newMessage],
            }
          : c
      )
    );

    setReplyText('');

    const targetPhone = activeCase.customerPhone || activeCustomer?.phone || '+1 (555) 234-5678';

    if (activeCase.channel === 'WHATSAPP' || targetPhone) {
      try {
        await fetch('/api/whatsapp/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toNumber: targetPhone,
            customerName: activeCase.customerName || 'Customer',
            textBody: text,
            orderId: activeCase.orderId,
          }),
        });
        setActionNotice(`✅ Support Agent reply dispatched to customer via WhatsApp (${targetPhone})!`);
      } catch {
        setActionNotice('Reply recorded in support ticket.');
      }
    } else {
      setActionNotice('Reply dispatched to customer via registered channel.');
    }

    setIsSendingReply(false);
    setTimeout(() => setActionNotice(null), 3500);
  };

  const handleAiQuickReply = (suggestion: string) => {
    setReplyText(suggestion);
  };

  // Policy-Checked Support Actions
  const handleInitiateRefund = () => {
    if (!matchingOrder) return;
    const supportMaxLimitCents = 500000; // KES 5,000 max support limit without manager escalation
    if (matchingOrder.totalCents > supportMaxLimitCents) {
      setActionNotice(
        `Refund request for ${formatCurrency(matchingOrder.totalCents, tenant.currency)} exceeds Support Agent limit (${formatCurrency(supportMaxLimitCents, tenant.currency)}). Case escalated to Manager for approval.`
      );
    } else {
      setActionNotice(
        `Refund initiated for ${formatCurrency(matchingOrder.totalCents, tenant.currency)}. M-PESA / Pesapal reversal requested.`
      );
    }
    setTimeout(() => setActionNotice(null), 4000);
  };

  const handleAddressUpdateStaged = () => {
    setActionNotice('Customer address modification staged for verification by Warehouse Fulfilment team.');
    setTimeout(() => setActionNotice(null), 3500);
  };

  return (
    <div className="space-y-6">
      {/* Editorial Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Customer Support & Omnichannel Inbox
            </h1>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
              Support Desk
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Omnichannel messaging, customer 360 profiles, live order tracking, and authorized refund/return workflows.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 p-0.5 bg-slate-200/80 rounded-lg text-xs font-medium">
            {['ALL', 'WhatsApp', 'Web Chat', 'Email'].map((channel) => (
              <button
                key={channel}
                onClick={() => setActiveChannel(channel)}
                className={`px-2.5 py-1 rounded-md transition-all ${
                  activeChannel === channel
                    ? 'bg-white text-slate-900 shadow-2xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {channel}
              </button>
            ))}
          </div>
        </div>
      </div>

      {actionNotice && (
        <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-900 flex items-center justify-between shadow-2xs animate-fade-in">
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="w-4 h-4 text-blue-600 shrink-0" />
            <span>{actionNotice}</span>
          </div>
        </div>
      )}

      {/* 3-Panel Omnichannel Support Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start h-[700px]">
        {/* Panel 1: Tickets List (3 cols) */}
        <div className="lg:col-span-3 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col h-full shadow-2xs">
          <div className="p-3 border-b border-slate-200 bg-slate-50">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search tickets, order #..."
                className="w-full pl-8 pr-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {filteredCases.map((c) => {
              const isSelected = activeCase?.id === c.id;
              return (
                <div
                  key={c.id}
                  onClick={() => setActiveCaseId(c.id)}
                  className={`p-3.5 cursor-pointer transition-colors space-y-1.5 ${
                    isSelected ? 'bg-slate-50 border-l-4 border-l-slate-900' : 'hover:bg-slate-50/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-semibold text-xs text-slate-900 truncate">
                        {c.customerName || c.customerEmail}
                      </span>
                      {c.channel === 'WHATSAPP' && (
                        <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                          WhatsApp
                        </span>
                      )}
                    </div>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                        c.priority === 'HIGH'
                          ? 'bg-rose-100 text-rose-800'
                          : c.priority === 'MEDIUM'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {c.priority}
                    </span>
                  </div>

                  <div className="text-xs text-slate-700 line-clamp-1 font-medium">{c.subject}</div>

                  <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono">
                    <span>{c.orderId || 'General inquiry'}</span>
                    <span
                      className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                        c.status === 'OPEN'
                          ? 'bg-amber-100 text-amber-800'
                          : c.status === 'RESOLVED'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-blue-100 text-blue-800'
                      }`}
                    >
                      {c.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Panel 2: Active Conversation Thread (5 cols) */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col h-full shadow-2xs">
          {activeCase ? (
            <>
              {/* Thread Header */}
              <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/70">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-sm text-slate-900">{activeCase.subject}</h3>
                    {activeCase.channel === 'WHATSAPP' && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                        WhatsApp Official
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-slate-500 mt-0.5">
                    <span>Ticket #{activeCase.id}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono">{activeCase.orderId}</span>
                    <span aria-hidden="true">·</span>
                    <span className={activeCase.humanTakeover ? 'text-amber-700 font-semibold' : 'text-purple-700 font-semibold'}>
                      {activeCase.humanTakeover ? 'Human Takeover (AI Paused)' : 'AI Copilot Active'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const nextTakeover = !activeCase.humanTakeover;
                      setCases((prev) =>
                        prev.map((c) =>
                          c.id === activeCase.id ? { ...c, humanTakeover: nextTakeover } : c
                        )
                      );
                      setActionNotice(
                        nextTakeover
                          ? 'Human Takeover Enabled: Automated AI replies paused for this WhatsApp customer.'
                          : 'AI Copilot Re-enabled: Automated responses will resume for customer messages.'
                      );
                      setTimeout(() => setActionNotice(null), 3500);
                    }}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-lg border transition-all ${
                      activeCase.humanTakeover
                        ? 'bg-amber-100 border-amber-300 text-amber-900 hover:bg-amber-200'
                        : 'bg-purple-50 border-purple-200 text-purple-700 hover:bg-purple-100'
                    }`}
                  >
                    {activeCase.humanTakeover ? 'Return to AI' : 'Human Takeover'}
                  </button>

                  <button
                    onClick={() => {
                      setCases((prev) =>
                        prev.map((c) => (c.id === activeCase.id ? { ...c, status: 'RESOLVED' } : c))
                      );
                      setActionNotice(`Ticket ${activeCase.id} marked as RESOLVED.`);
                      setTimeout(() => setActionNotice(null), 3000);
                    }}
                    className="px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors"
                  >
                    Mark Resolved
                  </button>
                </div>
              </div>

              {/* Messages Body */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {activeCase.messages.map((msg, idx) => {
                  const isCustomer = msg.sender === 'CUSTOMER';
                  const isAi = msg.sender === 'AI_ASSISTANT';
                  return (
                    <div
                      key={idx}
                      className={`flex flex-col ${isCustomer ? 'items-start' : 'items-end'}`}
                    >
                      <div className="flex items-center gap-1.5 text-[11px] text-slate-500 mb-1">
                        {isCustomer && <span className="font-semibold">{activeCase.customerName || activeCase.customerEmail}</span>}
                        {isAi && (
                          <span className="font-semibold text-purple-700 flex items-center gap-1">
                            <Sparkles className="w-3 h-3" /> OmniBot AI
                          </span>
                        )}
                        {!isCustomer && !isAi && <span className="font-semibold text-slate-800">Support Agent</span>}
                        <span>· {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>

                      <div
                        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed ${
                          isCustomer
                            ? 'bg-slate-100 text-slate-900 rounded-tl-xs'
                            : isAi
                            ? 'bg-purple-50 text-purple-950 border border-purple-200 rounded-tr-xs'
                            : 'bg-slate-900 text-white rounded-tr-xs'
                        }`}
                      >
                        {msg.text}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* AI Reply Suggestions */}
              <div className="p-3 bg-slate-50 border-t border-slate-200 space-y-2">
                <div className="flex items-center gap-1 text-[11px] font-bold text-slate-600">
                  <Sparkles className="w-3.5 h-3.5 text-purple-600" />
                  <span>AI Copilot Suggested Responses</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() =>
                      handleAiQuickReply(
                        `Hi ${(activeCase.customerName || 'there').split(' ')[0]}, your order ${activeCase.orderId} is currently being packed at our Nairobi Industrial Area Hub and is scheduled for dispatch today.`
                      )
                    }
                    className="px-2.5 py-1 bg-white border border-slate-200 hover:border-purple-300 rounded-md text-[11px] text-slate-700 hover:text-purple-900 transition-colors"
                  >
                    Send Tracking Status
                  </button>
                  <button
                    onClick={() =>
                      handleAiQuickReply(
                        `I have staged the address update for order ${activeCase.orderId}. Our warehouse team will confirm before handing over to the courier.`
                      )
                    }
                    className="px-2.5 py-1 bg-white border border-slate-200 hover:border-purple-300 rounded-md text-[11px] text-slate-700 hover:text-purple-900 transition-colors"
                  >
                    Confirm Address Change
                  </button>
                  <button
                    onClick={() =>
                      handleAiQuickReply(
                        `Our return policy allows 30 days for unused items with original tags. Would you like a prepaid return label?`
                      )
                    }
                    className="px-2.5 py-1 bg-white border border-slate-200 hover:border-purple-300 rounded-md text-[11px] text-slate-700 hover:text-purple-900 transition-colors"
                  >
                    Send Return Policy
                  </button>
                </div>
              </div>

              {/* Internal Notes Display */}
              {activeCase.internalNotes && activeCase.internalNotes.length > 0 && (
                <div className="px-4 py-2.5 bg-amber-50/70 border-t border-amber-200/80 space-y-1.5 text-xs text-amber-950">
                  <div className="font-bold text-[10px] uppercase tracking-wider text-amber-800 flex items-center gap-1.5">
                    <span>🔒 Internal Staff Notes (Never Sent to Customer)</span>
                  </div>
                  {activeCase.internalNotes.map((note) => (
                    <div key={note.id} className="p-2 bg-white rounded-lg border border-amber-200 text-[11px] text-slate-800">
                      <div className="flex justify-between font-semibold text-[10px] text-slate-500 mb-0.5">
                        <span>{note.author} ({note.authorRole})</span>
                        <span className="font-mono">{new Date(note.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <div>{note.note}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Message Composer Tabs */}
              <div className="border-t border-slate-200 bg-slate-50/50 p-2 flex items-center justify-between text-xs">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setComposerTab('REPLY')}
                    className={`px-3 py-1 rounded-lg font-semibold transition-all ${
                      composerTab === 'REPLY'
                        ? 'bg-slate-900 text-white shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Reply Customer
                  </button>
                  <button
                    onClick={() => setComposerTab('INTERNAL_NOTE')}
                    className={`px-3 py-1 rounded-lg font-semibold transition-all flex items-center gap-1 ${
                      composerTab === 'INTERNAL_NOTE'
                        ? 'bg-amber-400 text-slate-950 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <span>🔒 Internal Note</span>
                  </button>
                </div>

                <span className="text-[10px] text-slate-400">
                  {composerTab === 'REPLY' ? 'Sent via customer channel' : 'Stored in staff workspace'}
                </span>
              </div>

              {/* Composer Input Area */}
              <div className="p-3 border-t border-slate-200">
                {composerTab === 'REPLY' ? (
                  <div className="space-y-2">
                    {/* Active Channel & Agent indicator */}
                    <div className="px-3 py-1.5 bg-slate-900 text-white flex items-center justify-between text-[11px] font-medium rounded-lg shadow-2xs">
                      <div className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        <span>Support Agent Reply to <strong>{activeCase.customerName || 'Customer'}</strong></span>
                      </div>
                      <span className="font-mono text-[10px] text-emerald-300 bg-emerald-950/80 border border-emerald-500/40 px-2 py-0.5 rounded">
                        {activeCase.channel === 'WHATSAPP' || activeCase.customerPhone
                          ? `WhatsApp: ${activeCase.customerPhone || '+1 (555) 234-5678'}`
                          : 'Customer Channel'}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSendReply();
                        }}
                        disabled={isSendingReply}
                        placeholder={`Type official reply to ${activeCase.customerName || 'customer'}...`}
                        className="flex-1 px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
                      />
                      <button
                        onClick={() => handleSendReply()}
                        disabled={!replyText.trim() || isSendingReply}
                        className="px-4 py-2.5 bg-[#25D366] hover:bg-[#20bd5a] disabled:opacity-40 text-slate-950 font-bold rounded-xl text-xs transition-all shadow-2xs flex items-center gap-1.5 shrink-0"
                        title="Send Customer Reply"
                      >
                        {isSendingReply ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Send className="w-3.5 h-3.5" />
                        )}
                        <span>Send Reply</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <input
                      type="text"
                      value={internalNoteText}
                      onChange={(e) => setInternalNoteText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && internalNoteText.trim()) {
                          const newNote = {
                            id: `note-${Date.now()}`,
                            author: 'Support Staff',
                            authorRole: currentRole.replace(/_/g, ' '),
                            note: internalNoteText.trim(),
                            timestamp: new Date().toISOString(),
                          };
                          setCases((prev) =>
                            prev.map((c) =>
                              c.id === activeCase.id
                                ? { ...c, internalNotes: [...(c.internalNotes || []), newNote] }
                                : c
                            )
                          );
                          setInternalNoteText('');
                          setActionNotice('Internal staff note recorded (never visible to customer).');
                          setTimeout(() => setActionNotice(null), 3000);
                        }
                      }}
                      placeholder="Add confidential internal note for fulfillment / support team..."
                      className="flex-1 px-3 py-2 bg-amber-50/60 border border-amber-300 rounded-lg text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                    <button
                      onClick={() => {
                        if (!internalNoteText.trim()) return;
                        const newNote = {
                          id: `note-${Date.now()}`,
                          author: 'Support Staff',
                          authorRole: currentRole.replace(/_/g, ' '),
                          note: internalNoteText.trim(),
                          timestamp: new Date().toISOString(),
                        };
                        setCases((prev) =>
                          prev.map((c) =>
                            c.id === activeCase.id
                              ? { ...c, internalNotes: [...(c.internalNotes || []), newNote] }
                              : c
                          )
                        );
                        setInternalNoteText('');
                        setActionNotice('Internal staff note recorded (never visible to customer).');
                        setTimeout(() => setActionNotice(null), 3000);
                      }}
                      className="px-3 py-2 bg-amber-400 text-slate-950 font-bold rounded-lg hover:bg-amber-300 transition-colors text-xs"
                    >
                      Save Note
                    </button>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="text-center py-20 text-xs text-slate-500">Select a support ticket.</div>
          )}
        </div>

        {/* Panel 3: Customer 360 & Context (4 cols) */}
        <div className="lg:col-span-4 space-y-4 h-full overflow-y-auto">
          {/* Customer Profile Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3">
            <div className="flex items-center gap-3">
              <img
                src={activeCustomer.avatarUrl}
                alt={activeCustomer.name}
                className="w-11 h-11 rounded-full object-cover border border-slate-200"
              />
              <div>
                <div className="flex items-center gap-1.5">
                  <h4 className="font-bold text-sm text-slate-900">{activeCustomer.name}</h4>
                  {activeCustomer.vipStatus && (
                    <span className="px-1.5 py-0.2 bg-purple-100 text-purple-800 rounded text-[10px] font-bold">
                      VIP
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500">{activeCustomer.email}</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100 text-xs">
              <div className="p-2 bg-slate-50 rounded-lg">
                <span className="text-slate-500 block text-[11px]">Lifetime Spend</span>
                <span className="font-bold font-mono text-slate-900">
                  {formatCurrency(activeCustomer.lifetimeSpendCents, tenant.currency)}
                </span>
              </div>
              <div className="p-2 bg-slate-50 rounded-lg">
                <span className="text-slate-500 block text-[11px]">Total Orders</span>
                <span className="font-bold font-mono text-slate-900">
                  {activeCustomer.totalOrders} orders
                </span>
              </div>
            </div>

            <div className="text-xs text-slate-600 space-y-1">
              <div className="flex items-center gap-1.5">
                <Phone className="w-3.5 h-3.5 text-slate-400" />
                <span>{activeCustomer.phone}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-slate-400" />
                <span>{activeCustomer.location}</span>
              </div>
            </div>
          </div>

          {/* Associated Order Snapshot */}
          {matchingOrder ? (
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-900 font-mono">{matchingOrder.id}</span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-800">
                  {matchingOrder.status}
                </span>
              </div>

              <div className="divide-y divide-slate-100">
                {matchingOrder.items.map((item) => (
                  <div key={item.id} className="py-2 flex items-center justify-between">
                    <div>
                      <div className="font-medium text-slate-900">{item.title}</div>
                      <div className="text-[11px] text-slate-500 font-mono">
                        {item.sku} · Qty {item.quantity}
                      </div>
                    </div>
                    <span className="font-mono text-slate-700">
                      {formatCurrency(item.subtotalCents, tenant.currency)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="pt-2 border-t border-slate-200 flex items-center justify-between font-bold">
                <span>Order Total</span>
                <span className="font-mono">{formatCurrency(matchingOrder.totalCents, tenant.currency)}</span>
              </div>

              {/* Policy-Restricted Actions */}
              <div className="pt-2 border-t border-slate-100 space-y-1.5">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">
                  Support Policy Actions
                </span>
                <button
                  onClick={() => setShowInvoiceModal(true)}
                  className="w-full py-1.5 px-3 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-md text-xs font-semibold text-left flex items-center justify-between transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-emerald-600" />
                    <span>View KRA eTIMS Tax Invoice</span>
                  </span>
                  <ChevronRight className="w-3 h-3 text-emerald-600" />
                </button>
                <button
                  onClick={handleAddressUpdateStaged}
                  className="w-full py-1.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-md text-xs font-medium text-left flex items-center justify-between"
                >
                  <span>Stage Address Modification</span>
                  <ChevronRight className="w-3 h-3 text-slate-400" />
                </button>
                <button
                  onClick={handleInitiateRefund}
                  className="w-full py-1.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-md text-xs font-medium text-left flex items-center justify-between"
                >
                  <span>Initiate Authorized Refund ({formatCurrency(500000, tenant.currency)} max)</span>
                  <DollarSign className="w-3.5 h-3.5 text-emerald-600" />
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl p-4 text-xs text-slate-500 text-center">
              No specific order linked to this ticket.
            </div>
          )}

          {/* Instant Live Inventory Checker for Agents */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-2.5 text-xs">
            <div className="flex items-center gap-1.5 font-bold text-slate-900">
              <Package className="w-4 h-4 text-blue-600" />
              <span>Agent Live Stock Check</span>
            </div>
            <input
              type="text"
              value={stockSearchQuery}
              onChange={(e) => setStockSearchQuery(e.target.value)}
              placeholder="Filter SKU (e.g. TSHIRT001)..."
              className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded text-xs focus:outline-none"
            />
            <div className="max-h-36 overflow-y-auto divide-y divide-slate-100">
              {inventories
                .filter((inv) =>
                  stockSearchQuery.trim()
                    ? inv.sku.toLowerCase().includes(stockSearchQuery.toLowerCase())
                    : true
                )
                .slice(0, 4)
                .map((inv) => {
                  const avail = Math.max(0, inv.physicalStock - (inv.reservedStock + inv.quarantineStock));
                  return (
                    <div key={inv.sku} className="py-1.5 flex items-center justify-between">
                      <div>
                        <div className="font-mono font-bold text-slate-800">{inv.sku}</div>
                        <div className="text-[10px] text-slate-500">{inv.warehouseName.split(' ')[0]}</div>
                      </div>
                      <span
                        className={`font-mono text-xs font-bold ${
                          avail > 0 ? 'text-emerald-700' : 'text-rose-600'
                        }`}
                      >
                        {avail > 0 ? `${avail} avail` : 'Out of Stock'}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      </div>

      {/* Official KRA eTIMS Tax Invoice Modal */}
      {showInvoiceModal && matchingOrder && (
        <KraTaxInvoiceModal
          order={matchingOrder}
          tenant={tenant}
          onClose={() => setShowInvoiceModal(false)}
        />
      )}
    </div>
  );
};
