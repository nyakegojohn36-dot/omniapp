import React, { useState } from 'react';
import {
  TrendingUp,
  Package,
  Clock,
  Bot,
  AlertCircle,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  RefreshCw,
  ShoppingBag,
  Users,
  Layers,
  CreditCard,
  Settings,
  Sliders,
  DollarSign,
  Plus,
  Mail,
  Shield,
  Activity,
  Zap,
  Check,
  Store,
  Truck,
  MessageSquare,
  Bell,
  Globe,
} from 'lucide-react';
import { IntegrationConfig, Order, Product, StaffMember, Tenant, WarehouseInventory } from '../lib/types.ts';
import { formatCurrency } from '../lib/pricingEngine.ts';
import { SEED_CUSTOMER_PROFILES, SEED_INTEGRATIONS, SEED_STAFF_MEMBERS } from '../lib/sampleData.ts';

interface OverviewDashboardProps {
  tenant: Tenant;
  orders: Order[];
  products: Product[];
  inventories: WarehouseInventory[];
  activeReservationsCount: number;
  onNavigateTab: (tab: string) => void;
  onSweepExpired: () => void;
}

type SubSection = 'overview' | 'customers' | 'integrations' | 'team' | 'billing' | 'settings';

export const OverviewDashboard: React.FC<OverviewDashboardProps> = ({
  tenant,
  orders,
  products,
  inventories,
  activeReservationsCount,
  onNavigateTab,
  onSweepExpired,
}) => {
  const [activeSection, setActiveSection] = useState<SubSection>('overview');
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>(SEED_INTEGRATIONS);
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>(SEED_STAFF_MEMBERS);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<'FULFILLMENT_STAFF' | 'SUPPORT_STAFF' | 'SALES_STAFF'>('FULFILLMENT_STAFF');
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);

  // Tenant Settings Form State
  const [ttlMinutes, setTtlMinutes] = useState(tenant.reservationTTLMinutes);
  const [taxRate, setTaxRate] = useState(tenant.taxRatePercent);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);

  // Aggregate real revenue
  const totalRevenueCents = orders
    .filter((o) => o.isPaid)
    .reduce((acc, o) => acc + o.totalCents, 0);

  const pendingPaymentOrders = orders.filter((o) => o.status === 'AWAITING_PAYMENT');
  const confirmedProcessingOrders = orders.filter(
    (o) => o.status === 'CONFIRMED' || o.status === 'PROCESSING' || o.status === 'READY_FOR_DISPATCH'
  );

  // Out of stock and low stock analysis
  const outOfStockItems = inventories.filter(
    (i) => Math.max(0, i.physicalStock - (i.reservedStock + i.quarantineStock)) === 0
  );
  const lowStockItems = inventories.filter((i) => {
    const avail = Math.max(0, i.physicalStock - (i.reservedStock + i.quarantineStock));
    return avail > 0 && avail <= i.lowStockThreshold;
  });

  const handleToggleIntegration = (id: string) => {
    setIntegrations((prev) =>
      prev.map((int) =>
        int.id === id
          ? {
              ...int,
              status: int.status === 'CONNECTED' ? 'DISCONNECTED' : 'CONNECTED',
              lastSyncAt: 'Just now',
            }
          : int
      )
    );
  };

  const handleInviteStaff = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail || !inviteName) return;

    const newStaff: StaffMember = {
      id: `staff-${Date.now()}`,
      name: inviteName,
      email: inviteEmail,
      role: inviteRole,
      department:
        inviteRole === 'FULFILLMENT_STAFF'
          ? 'Warehouse Operations'
          : inviteRole === 'SUPPORT_STAFF'
          ? 'Customer Support'
          : 'Sales Team',
      status: 'INVITED',
      lastActive: 'Invitation Sent',
    };

    setStaffMembers((prev) => [...prev, newStaff]);
    setInviteNotice(`Invitation dispatched to ${inviteEmail} with ${inviteRole} permissions.`);
    setInviteEmail('');
    setInviteName('');
    setIsInviteModalOpen(false);
    setTimeout(() => setInviteNotice(null), 4000);
  };

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsNotice('Platform configuration saved and applied to inventory reservation engine.');
    setTimeout(() => setSettingsNotice(null), 3000);
  };

  return (
    <div className="space-y-6">
      {/* Editorial Header Section */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Business Owner Executive Suite
            </h1>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-900 text-white">
              Tenant Administrator
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500 mt-1">
            <span className="font-semibold text-slate-800">{tenant.name}</span>
            <span aria-hidden="true">·</span>
            <span>Global Operations & Automation Control</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{tenant.currency} ({tenant.timezone})</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onSweepExpired}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors shadow-2xs"
          >
            <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
            <span>Sweep Expired Holds</span>
          </button>
          <button
            onClick={() => onNavigateTab('orders')}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors shadow-2xs"
          >
            <span>All Orders ({orders.length})</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Sub-Section Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2 overflow-x-auto text-xs font-medium text-slate-600">
        <button
          onClick={() => setActiveSection('overview')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
            activeSection === 'overview'
              ? 'bg-slate-900 text-white font-semibold'
              : 'hover:bg-slate-100 text-slate-700'
          }`}
        >
          <Activity className="w-3.5 h-3.5" />
          <span>Executive Dashboard</span>
        </button>

        <button
          onClick={() => setActiveSection('customers')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
            activeSection === 'customers'
              ? 'bg-slate-900 text-white font-semibold'
              : 'hover:bg-slate-100 text-slate-700'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          <span>Customers & VIPs</span>
        </button>

        <button
          onClick={() => setActiveSection('integrations')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
            activeSection === 'integrations'
              ? 'bg-slate-900 text-white font-semibold'
              : 'hover:bg-slate-100 text-slate-700'
          }`}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>Integrations & Webhooks</span>
        </button>

        <button
          onClick={() => setActiveSection('team')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
            activeSection === 'team'
              ? 'bg-slate-900 text-white font-semibold'
              : 'hover:bg-slate-100 text-slate-700'
          }`}
        >
          <Shield className="w-3.5 h-3.5" />
          <span>Team & RBAC Permissions</span>
        </button>

        <button
          onClick={() => setActiveSection('billing')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
            activeSection === 'billing'
              ? 'bg-slate-900 text-white font-semibold'
              : 'hover:bg-slate-100 text-slate-700'
          }`}
        >
          <CreditCard className="w-3.5 h-3.5" />
          <span>Plan & AI Budget</span>
        </button>

        <button
          onClick={() => setActiveSection('settings')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
            activeSection === 'settings'
              ? 'bg-slate-900 text-white font-semibold'
              : 'hover:bg-slate-100 text-slate-700'
          }`}
        >
          <Settings className="w-3.5 h-3.5" />
          <span>Business Settings</span>
        </button>
      </div>

      {inviteNotice && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{inviteNotice}</span>
        </div>
      )}

      {settingsNotice && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-blue-600 shrink-0" />
          <span>{settingsNotice}</span>
        </div>
      )}

      {/* SECTION 1: EXECUTIVE DASHBOARD */}
      {activeSection === 'overview' && (
        <div className="space-y-6">
          {/* KPI Metric Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs">
              <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
                <span>Verified Revenue</span>
                <TrendingUp className="w-4 h-4 text-emerald-600" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold text-slate-900 font-mono tracking-tight tabular-nums">
                  {formatCurrency(totalRevenueCents, tenant.currency, tenant.locale)}
                </span>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                From {orders.filter((o) => o.isPaid).length} confirmed orders
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs">
              <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
                <span>Inventory Health</span>
                <Package className="w-4 h-4 text-blue-600" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold text-slate-900 font-mono tracking-tight tabular-nums">
                  {inventories.length}
                </span>
                <span className="text-xs text-slate-500">active SKU lines</span>
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs">
                {outOfStockItems.length > 0 ? (
                  <span className="text-rose-600 font-medium">
                    {outOfStockItems.length} out of stock
                  </span>
                ) : (
                  <span className="text-emerald-600 font-medium">100% available</span>
                )}
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="text-amber-600 font-medium">{lowStockItems.length} low stock</span>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs">
              <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
                <span>Active Stock Holds</span>
                <Clock className="w-4 h-4 text-amber-500" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold text-slate-900 font-mono tracking-tight tabular-nums">
                  {activeReservationsCount}
                </span>
                <span className="text-xs text-slate-500">live cart locks</span>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                TTL protected against overselling
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs">
              <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
                <span>AI Sales Automation</span>
                <Bot className="w-4 h-4 text-violet-600" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold text-slate-900 font-mono tracking-tight tabular-nums">
                  89.2%
                </span>
                <span className="text-xs text-emerald-600 font-medium">+4.8%</span>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                Grounded in stock & order tools
              </div>
            </div>
          </div>

          {/* Main Grid: Orders Flow & System Assurances */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl shadow-2xs overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    Live Authoritative Order Stream
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Server-authoritative state transitions with immutable audit history
                  </p>
                </div>
                <button
                  onClick={() => onNavigateTab('orders')}
                  className="text-xs font-medium text-slate-600 hover:text-slate-900"
                >
                  Manage State Machine &rarr;
                </button>
              </div>

              <div className="divide-y divide-slate-100">
                {orders.map((order) => {
                  const isAwaiting = order.status === 'AWAITING_PAYMENT';
                  const isShipped = order.status === 'SHIPPED';
                  const isConfirmed = order.status === 'CONFIRMED';

                  return (
                    <div
                      key={order.id}
                      className="p-4 hover:bg-slate-50/60 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-slate-900">
                            {order.id}
                          </span>
                          <span aria-hidden="true" className="text-slate-300">·</span>
                          <span className="text-slate-700 font-medium">
                            {order.customerName}
                          </span>
                          <span aria-hidden="true" className="text-slate-300">·</span>
                          <span className="text-slate-400">
                            {order.items.reduce((s, i) => s + i.quantity, 0)} items
                          </span>
                        </div>

                        <div className="text-slate-500">
                          {order.items.map((i) => `${i.title} (${i.quantity}x)`).join(', ')}
                        </div>
                      </div>

                      <div className="flex items-center gap-4 shrink-0">
                        <span className="font-mono font-semibold text-slate-900 tabular-nums">
                          {formatCurrency(order.totalCents, order.currency, tenant.locale)}
                        </span>

                        <span
                          className={`px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide ${
                            isAwaiting
                              ? 'bg-amber-100 text-amber-800'
                              : isConfirmed
                              ? 'bg-emerald-100 text-emerald-800'
                              : isShipped
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {order.status}
                        </span>

                        <button
                          onClick={() => onNavigateTab('orders')}
                          className="px-2.5 py-1 text-slate-700 hover:text-slate-900 border border-slate-200 rounded hover:bg-white text-[11px] font-medium transition-colors"
                        >
                          Inspect
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right Column: Invariants & Stock Warnings */}
            <div className="space-y-6">
              <div className="bg-slate-900 text-slate-100 rounded-xl p-5 shadow-2xs space-y-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <h3 className="text-sm font-semibold text-white">Platform Invariants Enforced</h3>
                </div>
                <ul className="space-y-2.5 text-xs text-slate-300">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    <span>
                      <strong>Role Isolation:</strong> Customers can never access internal metrics or staff controls.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    <span>
                      <strong>Atomic Stock Engine:</strong> Prevents overselling during high-concurrency flash drops.
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    <span>
                      <strong>Deterministic Fulfillment:</strong> Prepaid orders require confirmed charge before dispatch.
                    </span>
                  </li>
                </ul>
              </div>

              {/* Low stock list */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4 text-amber-500" />
                    <span>Inventory Reorder Alerts</span>
                  </h3>
                  <span className="text-xs text-slate-500 font-mono">Threshold &le; 5</span>
                </div>

                <div className="space-y-2">
                  {lowStockItems.length === 0 ? (
                    <p className="text-xs text-slate-500">All inventory levels healthy.</p>
                  ) : (
                    lowStockItems.map((item) => (
                      <div
                        key={`${item.sku}-${item.warehouseId}`}
                        className="p-2.5 rounded-lg bg-amber-50/60 border border-amber-200/60 flex items-center justify-between text-xs"
                      >
                        <div>
                          <div className="font-mono font-semibold text-slate-900">{item.sku}</div>
                          <div className="text-[11px] text-slate-500">{item.warehouseName}</div>
                        </div>
                        <div className="text-right">
                          <span className="font-mono font-bold text-amber-700 tabular-nums">
                            {item.physicalStock - item.reservedStock} left
                          </span>
                          <div className="text-[10px] text-slate-400">
                            {item.reservedStock} reserved
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SECTION 2: CUSTOMERS & VIPS */}
      {activeSection === 'customers' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
          <div className="p-4 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Customer Records & Lifetime Analytics</h3>
              <p className="text-xs text-slate-500">Verified buyer profiles, tiers, and omni-channel interactions</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                <tr>
                  <th className="py-3 px-4">Customer</th>
                  <th className="py-3 px-4">Location</th>
                  <th className="py-3 px-4">Tier / VIP</th>
                  <th className="py-3 px-4">Orders</th>
                  <th className="py-3 px-4">Lifetime Spend</th>
                  <th className="py-3 px-4">Last Activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {SEED_CUSTOMER_PROFILES.map((cust) => (
                  <tr key={cust.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <img
                          src={cust.avatarUrl}
                          alt={cust.name}
                          className="w-8 h-8 rounded-full object-cover border border-slate-200"
                        />
                        <div>
                          <div className="font-bold text-slate-900">{cust.name}</div>
                          <div className="text-[11px] text-slate-500">{cust.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-slate-600">{cust.location}</td>
                    <td className="py-3 px-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                          cust.vipStatus
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {cust.tier}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono font-medium text-slate-800">
                      {cust.totalOrders}
                    </td>
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">
                      {formatCurrency(cust.lifetimeSpendCents, tenant.currency)}
                    </td>
                    <td className="py-3 px-4 text-slate-500">{cust.lastOrderDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SECTION 3: INTEGRATIONS & WEBHOOKS */}
      {activeSection === 'integrations' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {integrations.map((item) => {
              const isConnected = item.status === 'CONNECTED';
              return (
                <div
                  key={item.id}
                  className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-4 flex flex-col justify-between"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-slate-800 font-bold">
                        {item.icon === 'Store' && <Store className="w-5 h-5" />}
                        {item.icon === 'CreditCard' && <CreditCard className="w-5 h-5 text-blue-600" />}
                        {item.icon === 'Truck' && <Truck className="w-5 h-5 text-amber-600" />}
                        {item.icon === 'MessageSquare' && <MessageSquare className="w-5 h-5 text-emerald-600" />}
                        {item.icon === 'Bell' && <Bell className="w-5 h-5 text-purple-600" />}
                        {item.icon === 'ShieldCheck' && <ShieldCheck className="w-5 h-5 text-teal-600" />}
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          isConnected
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {item.status}
                      </span>
                    </div>

                    <h4 className="font-bold text-sm text-slate-900">{item.name}</h4>
                    <p className="text-xs text-slate-500 leading-relaxed">{item.description}</p>
                  </div>

                  <div className="pt-3 border-t border-slate-100 space-y-2 text-xs">
                    <div className="text-[11px] text-slate-500 font-mono">{item.details}</div>
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-[11px] text-slate-400">Sync: {item.lastSyncAt}</span>
                      <button
                        onClick={() => handleToggleIntegration(item.id)}
                        className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                          isConnected
                            ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                            : 'bg-slate-900 text-white hover:bg-slate-800'
                        }`}
                      >
                        {isConnected ? 'Disconnect' : 'Connect'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* SECTION 4: TEAM & RBAC PERMISSIONS */}
      {activeSection === 'team' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Staff Accounts & Access Grants</h3>
                <p className="text-xs text-slate-500">Fine-grained Role-Based Access Control matrix</p>
              </div>

              <button
                onClick={() => setIsInviteModalOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800 shadow-2xs"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Invite Staff Member</span>
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                  <tr>
                    <th className="py-3 px-4">Staff Name</th>
                    <th className="py-3 px-4">Assigned Role</th>
                    <th className="py-3 px-4">Department</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Last Active</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {staffMembers.map((staff) => (
                    <tr key={staff.id} className="hover:bg-slate-50/60 transition-colors">
                      <td className="py-3 px-4">
                        <div className="font-bold text-slate-900">{staff.name}</div>
                        <div className="text-[11px] text-slate-500">{staff.email}</div>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                            staff.role === 'BUSINESS_OWNER'
                              ? 'bg-purple-100 text-purple-900'
                              : staff.role === 'FULFILLMENT_STAFF'
                              ? 'bg-blue-100 text-blue-900'
                              : 'bg-emerald-100 text-emerald-900'
                          }`}
                        >
                          {staff.role.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-700">{staff.department}</td>
                      <td className="py-3 px-4">
                        <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded text-[11px] font-medium border border-emerald-200">
                          {staff.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-500">{staff.lastActive}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SECTION 5: BILLING & AI USAGE */}
      {activeSection === 'billing' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                Current Plan
              </span>
              <span className="px-2.5 py-0.5 bg-emerald-100 text-emerald-800 rounded-full text-xs font-bold">
                Active
              </span>
            </div>

            <div>
              <h3 className="text-xl font-bold text-slate-900">Growth Plan &mdash; $199/month</h3>
              <p className="text-xs text-slate-500 mt-1">
                Unlimited sales channels, 15ms atomic stock locking, and 100,000 monthly orders.
              </p>
            </div>

            <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">AI Grounded Budget Remaining</span>
                <span className="font-mono font-bold text-slate-900">${tenant.aiBudgetRemaining.toFixed(2)} / $150.00</span>
              </div>
              <div className="w-full bg-slate-200 rounded-full h-2">
                <div
                  className="bg-purple-600 h-2 rounded-full"
                  style={{ width: `${(tenant.aiBudgetRemaining / 150) * 100}%` }}
                ></div>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-3">
            <h3 className="text-sm font-bold text-slate-900">Recent Invoices</h3>
            <div className="divide-y divide-slate-100 text-xs">
              <div className="py-2.5 flex items-center justify-between">
                <div>
                  <div className="font-medium text-slate-900">Invoice #INV-2026-10</div>
                  <div className="text-[11px] text-slate-400">Oct 01, 2026 · Visa ****4242</div>
                </div>
                <div className="text-right">
                  <span className="font-mono font-bold text-slate-900">$199.00</span>
                  <div className="text-[10px] text-emerald-600 font-bold">Paid</div>
                </div>
              </div>
              <div className="py-2.5 flex items-center justify-between">
                <div>
                  <div className="font-medium text-slate-900">Invoice #INV-2026-09</div>
                  <div className="text-[11px] text-slate-400">Sep 01, 2026 · Visa ****4242</div>
                </div>
                <div className="text-right">
                  <span className="font-mono font-bold text-slate-900">$199.00</span>
                  <div className="text-[10px] text-emerald-600 font-bold">Paid</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SECTION 6: SETTINGS */}
      {activeSection === 'settings' && (
        <form onSubmit={handleSaveSettings} className="bg-white border border-slate-200 rounded-xl p-6 shadow-2xs space-y-6 max-w-2xl">
          <h3 className="text-sm font-bold text-slate-900">Storefront & Checkout Policies</h3>

          <div className="space-y-4 text-xs">
            <div>
              <label className="block text-slate-700 font-semibold mb-1">
                Cart Hold Stock Reservation TTL (Minutes)
              </label>
              <input
                type="number"
                min="5"
                max="60"
                value={ttlMinutes}
                onChange={(e) => setTtlMinutes(Number(e.target.value))}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-slate-900 font-mono"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Amount of time stock remains guaranteed in customer cart before returning to available inventory.
              </p>
            </div>

            <div>
              <label className="block text-slate-700 font-semibold mb-1">
                Jurisdiction Tax Rate (%)
              </label>
              <input
                type="number"
                step="0.1"
                value={taxRate}
                onChange={(e) => setTaxRate(Number(e.target.value))}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-slate-900 font-mono"
              />
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 flex justify-end">
            <button
              type="submit"
              className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800"
            >
              Save Configuration
            </button>
          </div>
        </form>
      )}

      {/* Invite Staff Modal */}
      {isInviteModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleInviteStaff}
            className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200 space-y-4"
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3 className="font-bold text-slate-900 text-sm">Invite New Staff Member</h3>
              <button
                type="button"
                onClick={() => setIsInviteModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-semibold"
              >
                &times;
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  placeholder="e.g. Liam Scott"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Corporate Email</label>
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="liam.s@nordicpeak.com"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Assigned RBAC Role</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as any)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-slate-900"
                >
                  <option value="FULFILLMENT_STAFF">Fulfilment Staff (Pick, Pack, Dispatch)</option>
                  <option value="SUPPORT_STAFF">Customer Support (Tickets, Cases, Refunds)</option>
                  <option value="SALES_STAFF">Sales Staff (Inquiries & Catalog)</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setIsInviteModalOpen(false)}
                className="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-xs font-medium hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-semibold hover:bg-slate-800"
              >
                Send Invitation
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
