import React, { useState } from 'react';
import {
  LayoutDashboard,
  ShoppingCart,
  Tag,
  Package,
  Users,
  Truck,
  Bot,
  BarChart3,
  Layers,
  ShieldCheck,
  CreditCard,
  Settings,
  Search,
  Bell,
  ChevronDown,
  TrendingUp,
  Clock,
  AlertCircle,
  ArrowRight,
  RefreshCw,
  Plus,
  CheckCircle2,
  Sliders,
  DollarSign,
  Activity,
  Zap,
  Globe,
  ExternalLink,
  Store,
  MessageSquare,
  Sparkles,
  ShoppingBag,
  Headphones,
  Building2,
  Shield,
  UserCheck,
  UserX,
  ArrowUpRight,
  ArrowDownRight,
  X,
  Menu,
  Download,
} from 'lucide-react';
import {
  IntegrationConfig,
  Order,
  Product,
  StaffMember,
  Tenant,
  User,
  UserRole,
  WarehouseInventory,
} from '../lib/types.ts';
import { formatCurrency } from '../lib/pricingEngine.ts';
import {
  SEED_CUSTOMER_PROFILES,
  SEED_INTEGRATIONS,
  SEED_STAFF_MEMBERS,
} from '../lib/sampleData.ts';
import { getRoleAuditHistory, RoleAuditRecord } from '../lib/userStore.ts';

interface BusinessOwnerWorkspaceProps {
  tenant: Tenant;
  orders: Order[];
  products: Product[];
  inventories: WarehouseInventory[];
  activeReservationsCount: number;
  currentUser?: User;
  orderSyncStatus: 'loading' | 'connected' | 'error';
  users?: User[];
  onUpdateUserRole?: (targetUserId: string, newRole: UserRole, reason?: string) => void;
  onSwitchUser?: (user: User) => void;
  onNavigateTab: (tab: string) => void;
  onSweepExpired: () => void;
  onOpenConcurrencyModal: () => void;
  onUpdateOrder?: (order: Order) => void;
  renderOrderStateMachine: () => React.ReactNode;
  renderInventoryCatalog: () => React.ReactNode;
  renderFulfillmentView: () => React.ReactNode;
  renderAutomationView: () => React.ReactNode;
  renderAiAssistantView: () => React.ReactNode;
  renderWhatsAppView: () => React.ReactNode;
  renderSupportView?: () => React.ReactNode;
}

export type OwnerMenuSection =
  | 'dashboard'
  | 'orders'
  | 'products'
  | 'inventory'
  | 'customers'
  | 'fulfilment'
  | 'support'
  | 'sales_channels'
  | 'whatsapp'
  | 'automation'
  | 'analytics'
  | 'integrations'
  | 'team'
  | 'billing'
  | 'settings';

export const BusinessOwnerWorkspace: React.FC<BusinessOwnerWorkspaceProps> = ({
  tenant,
  orders,
  products,
  inventories,
  activeReservationsCount,
  currentUser,
  orderSyncStatus,
  users = [],
  onUpdateUserRole,
  onSwitchUser,
  onNavigateTab,
  onSweepExpired,
  onOpenConcurrencyModal,
  onUpdateOrder,
  renderOrderStateMachine,
  renderInventoryCatalog,
  renderFulfillmentView,
  renderAutomationView,
  renderAiAssistantView,
  renderWhatsAppView,
  renderSupportView,
}) => {
  const [activeMenu, setActiveMenu] = useState<OwnerMenuSection>('dashboard');
  const [conversationalSubTab, setConversationalSubTab] = useState<'assistant' | 'whatsapp'>('assistant');
  const [integrationsSubTab, setIntegrationsSubTab] = useState<'connectors' | 'automation'>('connectors');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [showDashboardRoleTools, setShowDashboardRoleTools] = useState(false);
  const handleSelectNav = (menu: OwnerMenuSection) => {
    setActiveMenu(menu);
    setMobileNavOpen(false);
  };
  const [dateRange, setDateRange] = useState<'today' | '7d' | '30d' | '90d'>('30d');
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>(SEED_INTEGRATIONS);
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>(SEED_STAFF_MEMBERS);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<'FULFILLMENT_STAFF' | 'SUPPORT_STAFF' | 'SALES_STAFF'>('FULFILLMENT_STAFF');
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);

  // Dynamic User Permissions & RBAC state
  const [userFilter, setUserFilter] = useState<'all' | 'customers' | 'staff'>('all');
  const [dashboardRoleFilter, setDashboardRoleFilter] = useState<'all' | 'customers' | 'staff'>('all');
  const [customerSubTab, setCustomerSubTab] = useState<'rbac' | 'vip'>('rbac');
  const [userSearch, setUserSearch] = useState('');
  const [roleChangeNotice, setRoleChangeNotice] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [auditLogs, setAuditLogs] = useState<RoleAuditRecord[]>(() => getRoleAuditHistory());

  // Dedicated Promote / Demote Modal State
  const [promoteModalUser, setPromoteModalUser] = useState<User | null>(null);
  const [modalTargetRole, setModalTargetRole] = useState<UserRole>('FULFILLMENT_STAFF');
  const [modalReason, setModalReason] = useState<string>('');

  const handleExportOrdersCsv = () => {
    const headers = [
      'Order ID',
      'Date',
      'Customer Name',
      'Customer Email',
      'Status',
      'Payment Method',
      'M-PESA Code',
      'KRA eTIMS Number',
      'Items Count',
      'Total KES',
      'Carrier',
      'Tracking Number',
    ];
    const rows = orders.map((o) => [
      o.id,
      new Date(o.createdAt).toLocaleDateString('en-KE'),
      `"${(o.customerName || 'Customer').replace(/"/g, '""')}"`,
      o.customerEmail,
      o.status,
      o.paymentMethod || 'M-PESA STK Push',
      o.mpesaReceiptCode || 'PENDING',
      o.etimsInvoiceNumber || 'PENDING',
      o.items.reduce((sum, item) => sum + item.quantity, 0),
      (o.totalCents / 100).toFixed(2),
      `"${(o.shippingCarrier || 'Sendy / Boda Express').replace(/"/g, '""')}"`,
      o.trackingNumber || 'PENDING',
    ]);
    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `SafariPeak_Orders_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const executeRoleChange = (targetUserId: string, newRole: UserRole, customReason?: string) => {
    const target = users.find((u) => u.id === targetUserId);
    if (!target) return;
    if (onUpdateUserRole) {
      const isPromotion = target.role === 'CUSTOMER' && newRole !== 'CUSTOMER';
      const isDemotion = target.role !== 'CUSTOMER' && newRole === 'CUSTOMER';
      const defaultReason = isPromotion
        ? `Promoted ${target.name} from Customer to ${newRole.replace(/_/g, ' ')} by Business Owner ${currentUser?.name || 'Alex'}`
        : isDemotion
        ? `Demoted ${target.name} from ${target.role.replace(/_/g, ' ')} to Customer by Business Owner ${currentUser?.name || 'Alex'}`
        : `Role adjusted for ${target.name} to ${newRole.replace(/_/g, ' ')} by Business Owner ${currentUser?.name || 'Alex'}`;

      onUpdateUserRole(targetUserId, newRole, customReason || defaultReason);
      setAuditLogs(getRoleAuditHistory());
      setRoleChangeNotice({
        text: isPromotion
          ? `🎉 Successfully promoted ${target.name} to ${newRole.replace(/_/g, ' ')}. Next time they log in, they will have direct access to their new staff dashboard and customer dashboard.`
          : isDemotion
          ? `🔻 Demoted ${target.name} to Customer. Internal staff dashboard permissions have been revoked; they are now limited to the customer storefront only.`
          : `Updated role for ${target.name} to ${newRole.replace(/_/g, ' ')}.`,
        type: 'success',
      });
      setTimeout(() => setRoleChangeNotice(null), 5000);
    }
    setPromoteModalUser(null);
  };

  // Settings state
  const [ttlMinutes, setTtlMinutes] = useState(tenant.reservationTTLMinutes);
  const [taxRate, setTaxRate] = useState(tenant.taxRatePercent);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);

  // Calculations
  const periodStart = new Date();
  if (dateRange === 'today') {
    periodStart.setHours(0, 0, 0, 0);
  } else {
    periodStart.setDate(periodStart.getDate() - Number.parseInt(dateRange, 10));
  }
  const periodOrders = orders.filter((order) => {
    const createdAt = Date.parse(order.createdAt);
    return Number.isFinite(createdAt) && createdAt >= periodStart.getTime();
  });
  const periodRevenueCents = periodOrders
    .filter((order) => order.isPaid)
    .reduce((total, order) => total + order.totalCents, 0);
  const pendingCount = orders.filter((order) => order.status === 'AWAITING_PAYMENT').length;
  const processingCount = orders.filter(
    (o) => o.status === 'CONFIRMED' || o.status === 'PROCESSING' || o.status === 'READY_FOR_DISPATCH'
  ).length;

  const outOfStockItems = inventories.filter(
    (i) => Math.max(0, i.physicalStock - (i.reservedStock + i.quarantineStock)) === 0
  );
  const lowStockItems = inventories.filter((i) => {
    const avail = Math.max(0, i.physicalStock - (i.reservedStock + i.quarantineStock));
    return avail > 0 && avail <= i.lowStockThreshold;
  });
  const channelLabels: Record<Tenant['channels'][number], string> = {
    WEB: 'Online store',
    WHATSAPP: 'WhatsApp',
    SHOPIFY_SYNC: 'Shopify',
    MARKETPLACE: 'Marketplace',
  };
  const channelSummaries = tenant.channels.map((channel) => {
    const channelOrders = periodOrders.filter((order) => order.sourceChannel === channel);
    return {
      channel,
      orderCount: channelOrders.length,
      paidSalesCents: channelOrders
        .filter((order) => order.isPaid)
        .reduce((total, order) => total + order.totalCents, 0),
    };
  });

  const handleToggleIntegration = (id: string) => {
    setIntegrations((prev) =>
      prev.map((int) =>
        int.id === id
          ? {
              ...int,
              status: int.status === 'CONNECTED' ? 'DISCONNECTED' : 'CONNECTED',
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
    setInviteNotice(`Invitation sent to ${inviteEmail} with ${inviteRole} permissions.`);
    setInviteEmail('');
    setInviteName('');
    setIsInviteModalOpen(false);
    setTimeout(() => setInviteNotice(null), 4000);
  };

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsNotice('Store settings and reservation TTL updated successfully.');
    setTimeout(() => setSettingsNotice(null), 3000);
  };

  const sectionTitles: Record<OwnerMenuSection, string> = {
    dashboard: 'Overview',
    orders: 'Orders',
    products: 'Products',
    inventory: 'Inventory',
    customers: 'Customers',
    fulfilment: 'Fulfilment',
    support: 'Customer support',
    sales_channels: 'AI & WhatsApp sales',
    whatsapp: 'AI & WhatsApp sales',
    automation: 'Integrations',
    analytics: 'Analytics',
    integrations: 'Integrations',
    team: 'Team & access',
    billing: 'Billing',
    settings: 'Store settings',
  };

  return (
    <div className="flex bg-slate-50 min-h-[calc(100vh-65px)] relative overflow-x-hidden">
      {/* Mobile Drawer Backdrop */}
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="Close navigation menu"
          onClick={() => setMobileNavOpen(false)}
          className="fixed inset-0 bg-slate-950/60 z-30 md:hidden backdrop-blur-xs transition-opacity"
        />
      )}

      <aside
        id="owner-navigation"
        aria-label="Owner workspace navigation"
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-slate-900 text-slate-300 flex flex-col shrink-0 border-r border-slate-800 transition-transform duration-200 md:static md:translate-x-0 ${
          mobileNavOpen ? 'visible translate-x-0' : 'invisible -translate-x-full md:visible md:translate-x-0'
        }`}
      >
        {/* Store Profile Section */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-teal-500 to-blue-600 text-white font-black flex items-center justify-center text-sm shadow-md shrink-0">
              {tenant.name
                .split(/\s+/)
                .slice(0, 2)
                .map((word) => word[0])
                .join('')
                .toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-bold text-sm text-white truncate">{tenant.name}</div>
              <div className="flex items-center gap-1.5 text-[11px] text-amber-300 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-300"></span>
                <span>Demo data</span>
              </div>
            </div>
          </div>
          <button
            onClick={() => setMobileNavOpen(false)}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg md:hidden"
            aria-label="Close navigation menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Sidebar Nav Links */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6 text-xs" aria-label="Owner workspace sections">
          {/* Main Navigation Group */}
          <div className="space-y-1">
            <div className="px-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">
              Commerce
            </div>

            <button
              onClick={() => handleSelectNav('dashboard')}
              aria-current={activeMenu === 'dashboard' ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-medium transition-colors ${
                activeMenu === 'dashboard'
                  ? 'bg-teal-500/10 text-teal-300 font-semibold border-l-2 border-teal-400'
                  : 'hover:bg-slate-800/80 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <LayoutDashboard className="w-4 h-4 text-slate-400" />
                <span>Dashboard</span>
              </div>
            </button>

            <button
              onClick={() => handleSelectNav('orders')}
              aria-current={activeMenu === 'orders' ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-medium transition-colors ${
                activeMenu === 'orders'
                  ? 'bg-teal-500/10 text-teal-300 font-semibold border-l-2 border-teal-400'
                  : 'hover:bg-slate-800/80 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <ShoppingCart className="w-4 h-4 text-slate-400" />
                <span>Orders</span>
              </div>
              <span className="px-1.5 py-0.2 bg-slate-800 text-slate-300 rounded font-mono text-[10px] font-bold">
                {orders.length}
              </span>
            </button>

            <button
              onClick={() => handleSelectNav('products')}
              aria-current={activeMenu === 'products' ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-medium transition-colors ${
                activeMenu === 'products'
                  ? 'bg-teal-500/10 text-teal-300 font-semibold border-l-2 border-teal-400'
                  : 'hover:bg-slate-800/80 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Tag className="w-4 h-4 text-slate-400" />
                <span>Products</span>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">{products.length}</span>
            </button>

            <button
              onClick={() => handleSelectNav('inventory')}
              aria-current={activeMenu === 'inventory' ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-medium transition-colors ${
                activeMenu === 'inventory'
                  ? 'bg-teal-500/10 text-teal-300 font-semibold border-l-2 border-teal-400'
                  : 'hover:bg-slate-800/80 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Package className="w-4 h-4 text-slate-400" />
                <span>Inventory</span>
              </div>
              {lowStockItems.length > 0 && (
                <span className="px-1.5 py-0.2 bg-amber-500/20 text-amber-300 rounded font-mono text-[10px] font-bold">
                  {lowStockItems.length}
                </span>
              )}
            </button>

            <button
              onClick={() => handleSelectNav('customers')}
              aria-current={activeMenu === 'customers' ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-medium transition-colors ${
                activeMenu === 'customers'
                  ? 'bg-teal-500/10 text-teal-300 font-semibold border-l-2 border-teal-400'
                  : 'hover:bg-slate-800/80 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Users className="w-4 h-4 text-emerald-400" />
                <span>Customers & Accounts</span>
              </div>
              <span className="px-1.5 py-0.5 bg-slate-800 text-slate-300 rounded font-mono text-[10px] font-bold">
                {users.length}
              </span>
            </button>

            <button
              onClick={() => handleSelectNav('fulfilment')}
              aria-current={activeMenu === 'fulfilment' ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-medium transition-colors ${
                activeMenu === 'fulfilment'
                  ? 'bg-teal-500/10 text-teal-300 font-semibold border-l-2 border-teal-400'
                  : 'hover:bg-slate-800/80 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Truck className="w-4 h-4 text-slate-400" />
                <span>Fulfilment</span>
              </div>
              <span className="px-1.5 py-0.2 bg-blue-500/20 text-blue-300 rounded font-mono text-[10px] font-bold">
                {processingCount}
              </span>
            </button>
          </div>

          {/* AI & Automation Group */}
          <div className="space-y-1">
            <div className="px-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">
              Customer & Growth
            </div>

            <button
              onClick={() => handleSelectNav('support')}
              aria-current={activeMenu === 'support' ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-medium transition-colors ${
                activeMenu === 'support'
                  ? 'bg-teal-500/10 text-teal-300 font-semibold border-l-2 border-teal-400'
                  : 'hover:bg-slate-800/80 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Headphones className="w-4 h-4 text-sky-400" />
                <span>Customer Support</span>
              </div>
              <span className="px-1.5 py-0.5 bg-sky-500/20 text-sky-300 rounded font-mono text-[10px] font-bold">
                Inbox
              </span>
            </button>

            <button
              onClick={() => handleSelectNav('sales_channels')}
              aria-current={activeMenu === 'sales_channels' ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-medium transition-colors ${
                activeMenu === 'sales_channels' || activeMenu === 'whatsapp'
                  ? 'bg-teal-500/10 text-teal-300 font-semibold border-l-2 border-teal-400'
                  : 'hover:bg-slate-800/80 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Sparkles className="w-4 h-4 text-emerald-400" />
                <span>AI & WhatsApp Sales</span>
              </div>
            </button>

            <button
              onClick={() => handleSelectNav('analytics')}
              aria-current={activeMenu === 'analytics' ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-medium transition-colors ${
                activeMenu === 'analytics'
                  ? 'bg-teal-500/10 text-teal-300 font-semibold border-l-2 border-teal-400'
                  : 'hover:bg-slate-800/80 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <BarChart3 className="w-4 h-4 text-slate-400" />
                <span>Analytics & Reports</span>
              </div>
            </button>

            <button
              onClick={() => handleSelectNav('integrations')}
              aria-current={activeMenu === 'integrations' || activeMenu === 'automation' ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-medium transition-colors ${
                activeMenu === 'integrations' || activeMenu === 'automation'
                  ? 'bg-teal-500/10 text-teal-300 font-semibold border-l-2 border-teal-400'
                  : 'hover:bg-slate-800/80 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Layers className="w-4 h-4 text-slate-400" />
                <span>Integrations & Webhooks</span>
              </div>
              <span className="px-1.5 py-0.2 bg-amber-500/20 text-amber-200 rounded font-mono text-[10px] font-bold">
                Demo
              </span>
            </button>
          </div>

          {/* Settings & Configuration Group */}
          <div className="space-y-1">
            <div className="px-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">
              Settings & Access
            </div>

            <button
              onClick={() => handleSelectNav('team')}
              aria-current={activeMenu === 'team' ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-medium transition-colors ${
                activeMenu === 'team'
                  ? 'bg-teal-500/10 text-teal-300 font-semibold border-l-2 border-teal-400'
                  : 'hover:bg-slate-800/80 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="w-4 h-4 text-amber-400" />
                <span>Staff Roles & RBAC</span>
              </div>
            </button>

            <button
              onClick={() => handleSelectNav('billing')}
              aria-current={activeMenu === 'billing' ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-medium transition-colors ${
                activeMenu === 'billing'
                  ? 'bg-teal-500/10 text-teal-300 font-semibold border-l-2 border-teal-400'
                  : 'hover:bg-slate-800/80 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <CreditCard className="w-4 h-4 text-slate-400" />
                <span>Billing & Subscription</span>
              </div>
            </button>

            <button
              onClick={() => handleSelectNav('settings')}
              aria-current={activeMenu === 'settings' ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-medium transition-colors ${
                activeMenu === 'settings'
                  ? 'bg-teal-500/10 text-teal-300 font-semibold border-l-2 border-teal-400'
                  : 'hover:bg-slate-800/80 text-slate-300'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Settings className="w-4 h-4 text-slate-400" />
                <span>Store Settings</span>
              </div>
            </button>
          </div>
        </nav>

        {/* Sidebar Footer User Info */}
        <div className="p-3 border-t border-slate-800 bg-slate-950/50 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-full bg-slate-700 text-white font-bold flex items-center justify-center text-[11px]">
              {(currentUser?.name || 'Business Owner')
                .split(' ')
                .map((p) => p[0])
                .join('')
                .slice(0, 2)
                .toUpperCase()}
            </div>
            <div className="truncate">
              <div className="text-white font-semibold truncate">{currentUser?.name || 'Alex Rivera'}</div>
              <div className="text-[10px] text-slate-500">Business Owner</div>
            </div>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
      <header className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3 sticky top-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => setMobileNavOpen(true)}
            className="p-1.5 -ml-1 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg md:hidden"
            aria-label="Open Navigation Menu"
            aria-expanded={mobileNavOpen}
            aria-controls="owner-navigation"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-sm font-bold text-slate-900 truncate">{sectionTitles[activeMenu]}</h1>
              <span
                role={orderSyncStatus === 'error' ? 'alert' : 'status'}
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  orderSyncStatus === 'error'
                    ? 'bg-amber-50 text-amber-900'
                    : orderSyncStatus === 'loading'
                    ? 'bg-slate-100 text-slate-700'
                    : 'bg-emerald-50 text-emerald-800'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${
                    orderSyncStatus === 'error'
                      ? 'bg-amber-600'
                      : orderSyncStatus === 'loading'
                      ? 'bg-slate-500'
                      : 'bg-emerald-600'
                  }`}
                />
                {orderSyncStatus === 'error'
                  ? 'Sync unavailable · showing current data'
                  : orderSyncStatus === 'loading'
                  ? 'Syncing demo orders…'
                  : 'Demo API synced'}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 truncate">{tenant.name}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {(activeMenu === 'dashboard' || activeMenu === 'analytics') && (
            <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-lg text-xs font-semibold" role="group" aria-label="Filter dashboard by date">
              {(['today', '7d', '30d', '90d'] as const).map((range) => (
                <button
                  key={range}
                  type="button"
                  onClick={() => setDateRange(range)}
                  aria-pressed={dateRange === range}
                  className={`px-2.5 py-1.5 rounded-md transition-colors uppercase text-[11px] ${
                    dateRange === range
                      ? 'bg-white text-slate-900 shadow-2xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {range === 'today' ? 'Today' : range}
                </button>
              ))}
            </div>
          )}

          {activeMenu === 'orders' && (
            <button
              onClick={handleExportOrdersCsv}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors"
              title="Download orders as CSV"
            >
              <Download className="w-3.5 h-3.5 text-emerald-400" />
              <span>Export CSV</span>
            </button>
          )}
        </div>
      </header>

        {/* View Router based on activeMenu */}
        <div className="p-4 sm:p-6 space-y-6">
          {/* Global Role Change & RBAC Alert Notice */}
          {roleChangeNotice && (
            <div
              className={`p-4 rounded-2xl border text-xs flex items-center justify-between gap-3 shadow-md transition-all animate-in fade-in duration-200 ${
                roleChangeNotice.type === 'success'
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-950 ring-1 ring-emerald-400'
                  : 'bg-red-50 border-red-300 text-red-950 ring-1 ring-red-400'
              }`}
            >
              <div className="flex items-start sm:items-center gap-3">
                {roleChangeNotice.type === 'success' ? (
                  <div className="w-8 h-8 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0 border border-emerald-300">
                    <CheckCircle2 className="w-5 h-5" />
                  </div>
                ) : (
                  <div className="w-8 h-8 rounded-xl bg-red-100 text-red-700 flex items-center justify-center shrink-0 border border-red-300">
                    <AlertCircle className="w-5 h-5" />
                  </div>
                )}
                <div>
                  <div className="font-bold text-sm text-slate-900">
                    {roleChangeNotice.type === 'success' ? 'Role Updated Authoritatively' : 'Authorization Error'}
                  </div>
                  <p className="font-medium text-slate-700 mt-0.5 leading-relaxed">{roleChangeNotice.text}</p>
                </div>
              </div>
              <button
                onClick={() => setRoleChangeNotice(null)}
                className="text-slate-400 hover:text-slate-700 text-base font-bold px-2 py-1 rounded-lg hover:bg-slate-200/60"
              >
                &times;
              </button>
            </div>
          )}

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

          {/* SECTION: DASHBOARD */}
          {activeMenu === 'dashboard' && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h2 className="text-xl font-bold text-slate-900">
                    Welcome, {(currentUser?.name || 'Business Owner').split(' ')[0]}
                  </h2>
                  <p className="text-sm text-slate-600 mt-1">
                    Orders and inventory at a glance for {tenant.name}.
                  </p>
                  <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900">
                    Demo workspace · no live provider connections
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveMenu('orders')}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                  >
                    View orders <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveMenu('inventory')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Review inventory
                  </button>
                </div>
              </div>

              {/* KPI Cards Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
                  <div className="flex items-center justify-between text-xs font-medium text-slate-600">
                    <span>Paid sales</span>
                    <TrendingUp className="h-4 w-4 text-emerald-600" />
                  </div>
                  <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-slate-900">
                    {formatCurrency(periodRevenueCents, tenant.currency)}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">Selected period</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
                  <div className="flex items-center justify-between text-xs font-medium text-slate-600">
                    <span>Orders</span>
                    <ShoppingCart className="h-4 w-4 text-blue-600" />
                  </div>
                  <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-slate-900">
                    {periodOrders.length}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">Created in selected period</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
                  <div className="flex items-center justify-between text-xs font-medium text-slate-600">
                    <span>Awaiting payment</span>
                    <Clock className="h-4 w-4 text-amber-600" />
                  </div>
                  <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-slate-900">
                    {pendingCount}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">Needs payment confirmation</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
                  <div className="flex items-center justify-between text-xs font-medium text-slate-600">
                    <span>In fulfilment</span>
                    <Package className="h-4 w-4 text-indigo-600" />
                  </div>
                  <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-slate-900">
                    {processingCount}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">Active orders across all time</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs" aria-labelledby="order-activity-heading">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 id="order-activity-heading" className="text-sm font-bold text-slate-900">Order activity</h3>
                      <p className="mt-1 text-xs text-slate-500">
                        {dateRange === 'today' ? 'Today' : `Last ${dateRange}`} · {periodOrders.length} orders
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveMenu('orders')}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 hover:text-slate-950"
                    >
                      View orders <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-xl bg-amber-50 p-3">
                      <dt className="text-xs text-amber-900">Awaiting payment</dt>
                      <dd className="mt-1 font-mono text-lg font-bold text-amber-950">
                        {periodOrders.filter((order) => order.status === 'AWAITING_PAYMENT').length}
                      </dd>
                    </div>
                    <div className="rounded-xl bg-blue-50 p-3">
                      <dt className="text-xs text-blue-900">In fulfilment</dt>
                      <dd className="mt-1 font-mono text-lg font-bold text-blue-950">
                        {periodOrders.filter((order) =>
                          ['CONFIRMED', 'PROCESSING', 'READY_FOR_DISPATCH'].includes(order.status)
                        ).length}
                      </dd>
                    </div>
                    <div className="rounded-xl bg-emerald-50 p-3">
                      <dt className="text-xs text-emerald-900">Delivered</dt>
                      <dd className="mt-1 font-mono text-lg font-bold text-emerald-950">
                        {periodOrders.filter((order) => order.status === 'DELIVERED').length}
                      </dd>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <dt className="text-xs text-slate-700">Paid sales</dt>
                      <dd className="mt-1 font-mono text-lg font-bold text-slate-950">
                        {formatCurrency(periodRevenueCents, tenant.currency)}
                      </dd>
                    </div>
                  </dl>
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs" aria-labelledby="inventory-health-heading">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 id="inventory-health-heading" className="text-sm font-bold text-slate-900">Inventory attention</h3>
                      <p className="mt-1 text-xs text-slate-500">Based on current available stock</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveMenu('inventory')}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 hover:text-slate-950"
                    >
                      Review stock <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-5 grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-red-100 bg-red-50 p-4">
                      <p className="text-xs font-medium text-red-900">Out of stock</p>
                      <p className="mt-1 font-mono text-2xl font-bold text-red-950">{outOfStockItems.length}</p>
                    </div>
                    <div className="rounded-xl border border-amber-100 bg-amber-50 p-4">
                      <p className="text-xs font-medium text-amber-900">Low stock</p>
                      <p className="mt-1 font-mono text-2xl font-bold text-amber-950">{lowStockItems.length}</p>
                    </div>
                  </div>
                  {outOfStockItems.length === 0 && lowStockItems.length === 0 && (
                    <p className="mt-4 text-xs text-slate-600">No stock alerts right now.</p>
                  )}
                </section>
              </div>

              {/* Recent activity and follow-up */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs">
                  <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                    <div>
                      <h3 className="font-bold text-sm text-slate-900">Recent orders</h3>
                      <p className="text-xs text-slate-500">Orders created in the selected period</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveMenu('orders')}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 hover:text-slate-950"
                    >
                      <span>View All Orders</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="divide-y divide-slate-100 text-xs">
                    {periodOrders.slice(0, 5).map((ord) => (
                      <div key={ord.id} className="flex flex-col gap-3 p-4 transition-colors hover:bg-slate-50/60 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-slate-900">{ord.id}</span>
                            <span className="text-slate-300">·</span>
                            <span className="truncate font-medium text-slate-700">{ord.customerName}</span>
                            <span className="text-slate-300">·</span>
                            <span className="text-slate-400 font-mono">{ord.items.length} items</span>
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-slate-500">
                            {ord.items.map((i) => i.title).join(', ')}
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-3 sm:gap-4">
                          <span className="font-mono font-bold text-slate-900">
                            {formatCurrency(ord.totalCents, ord.currency)}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                              ord.status === 'CONFIRMED'
                                ? 'bg-emerald-100 text-emerald-800'
                                : ord.status === 'SHIPPED'
                                ? 'bg-blue-100 text-blue-800'
                                : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {ord.status}
                          </span>
                        </div>
                      </div>
                    ))}
                    {periodOrders.length === 0 && (
                      <div className="p-6 text-center">
                        <p className="text-sm font-semibold text-slate-800">No orders in this date range</p>
                        <p className="mt-1 text-xs text-slate-500">Try a longer range or check back when new orders arrive.</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-sm font-bold text-slate-900">
                        <AlertCircle className="h-4 w-4 text-amber-600" />
                        <span>Stock alerts</span>
                      </span>
                      <span className="font-mono text-xs text-slate-500">{lowStockItems.length + outOfStockItems.length}</span>
                    </div>

                    <div className="mt-3 space-y-2">
                      {[...outOfStockItems, ...lowStockItems].slice(0, 5).map((inv) => (
                        <div
                          key={`${inv.sku}-${inv.warehouseId}`}
                          className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-2.5"
                        >
                          <div className="min-w-0">
                            <div className="font-mono font-bold text-slate-900">{inv.sku}</div>
                            <div className="truncate text-[10px] text-slate-500">{inv.warehouseName}</div>
                          </div>
                          <span className="shrink-0 font-mono text-xs font-bold text-slate-700">
                            {Math.max(0, inv.physicalStock - inv.reservedStock - inv.quarantineStock)} available
                          </span>
                        </div>
                      ))}
                      {lowStockItems.length + outOfStockItems.length === 0 && (
                        <p className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-900">
                          No low-stock or out-of-stock items.
                        </p>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setActiveMenu('team')}
                    className="w-full rounded-xl border border-slate-200 bg-white p-4 text-left shadow-2xs transition hover:border-slate-300 hover:bg-slate-50"
                  >
                    <span className="block text-sm font-semibold text-slate-900">Manage team access</span>
                    <span className="mt-1 block text-xs text-slate-600">
                      Review staff roles, customer accounts, and permissions.
                    </span>
                  </button>
                </div>
              </div>

              {!showDashboardRoleTools && (
                <button
                  type="button"
                  onClick={() => setShowDashboardRoleTools(true)}
                  aria-expanded={false}
                  className="text-xs font-medium text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900"
                >
                  Open quick role management
                </button>
              )}
              {showDashboardRoleTools && (
              <div id="admin-promotion-center" className="scroll-mt-6 space-y-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xs">
                <div className="p-5 border-b border-slate-200 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-indigo-500/30 text-indigo-200 text-[11px] font-bold">
                      <ShieldCheck className="w-3.5 h-3.5 text-indigo-300" />
                      <span>Admin Role Delegation</span>
                    </div>
                    <h3 className="text-base font-extrabold text-white tracking-tight">
                      Customer Role Promotion & Demotion Center
                    </h3>
                    <p className="text-xs text-slate-300">
                      Promote customer accounts to Fulfillment Staff, Support Agents, or Co-Admin. Demote staff back to Customer at any time.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowDashboardRoleTools(false)}
                      aria-expanded={true}
                      className="px-3.5 py-1.5 rounded-xl border border-slate-600 text-xs font-semibold text-slate-100 transition hover:bg-slate-800"
                    >
                      Hide quick tools
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveMenu('team')}
                      className="px-3.5 py-1.5 bg-white text-slate-900 hover:bg-slate-100 rounded-xl text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 shrink-0"
                    >
                      <span>Full RBAC & Audit Matrix</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Quick Role Filter Pills */}
                <div className="px-5 pt-1 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setDashboardRoleFilter('all')}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                        dashboardRoleFilter === 'all'
                          ? 'bg-slate-900 text-white shadow-2xs'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      All Accounts ({users.length})
                    </button>
                    <button
                      onClick={() => setDashboardRoleFilter('customers')}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                        dashboardRoleFilter === 'customers'
                          ? 'bg-emerald-700 text-white shadow-2xs'
                          : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100 border border-emerald-200'
                      }`}
                    >
                      Customers ({users.filter((u) => u.role === 'CUSTOMER').length} Promotable)
                    </button>
                    <button
                      onClick={() => setDashboardRoleFilter('staff')}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                        dashboardRoleFilter === 'staff'
                          ? 'bg-indigo-700 text-white shadow-2xs'
                          : 'bg-indigo-50 text-indigo-800 hover:bg-indigo-100 border border-indigo-200'
                      }`}
                    >
                      Active Staff & Admins ({users.filter((u) => u.role !== 'CUSTOMER').length})
                    </button>
                  </div>

                  <div className="text-[11px] text-slate-500">
                    Promoted staff access their designated workstation + customer dashboard.
                  </div>
                </div>

                {/* Promotion / Demotion Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-y border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                      <tr>
                        <th className="py-3 px-5">User / Account</th>
                        <th className="py-3 px-4">Current Role</th>
                        <th className="py-3 px-4">Direct Promote / Demote Action</th>
                        <th className="py-3 px-4">Authorized Dashboards</th>
                        <th className="py-3 px-4 text-right">Preview</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {users
                        .filter((u) => {
                          if (dashboardRoleFilter === 'customers') return u.role === 'CUSTOMER';
                          if (dashboardRoleFilter === 'staff') return u.role !== 'CUSTOMER';
                          return true;
                        })
                        .map((u) => {
                          const isCurrentUser = currentUser?.id === u.id;
                          const isCustomer = u.role === 'CUSTOMER';

                          return (
                            <tr key={u.id} className="hover:bg-slate-50/80 transition-colors">
                              <td className="py-3 px-5">
                                <div className="flex items-center gap-3">
                                  <div className="w-8 h-8 rounded-full bg-slate-900 text-white font-bold text-xs flex items-center justify-center shrink-0">
                                    {u.name
                                      .split(' ')
                                      .map((p) => p[0])
                                      .join('')
                                      .slice(0, 2)
                                      .toUpperCase()}
                                  </div>
                                  <div>
                                    <div className="font-bold text-slate-900 flex items-center gap-1.5">
                                      <span>{u.name}</span>
                                      {isCurrentUser && (
                                        <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-slate-200 text-slate-800">
                                          You (Admin)
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-[11px] text-slate-500 font-mono">{u.email}</div>
                                  </div>
                                </div>
                              </td>

                              <td className="py-3 px-4">
                                <div className="flex items-center gap-1.5">
                                  <span
                                    className={`px-2.5 py-1 rounded-full text-[11px] font-bold border inline-flex items-center gap-1 ${
                                      u.role === 'CUSTOMER'
                                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                        : u.role === 'FULFILLMENT_STAFF'
                                        ? 'bg-amber-50 text-amber-700 border-amber-200'
                                        : u.role === 'SUPPORT_STAFF'
                                        ? 'bg-sky-50 text-sky-700 border-sky-200'
                                        : 'bg-indigo-50 text-indigo-700 border-indigo-200'
                                    }`}
                                  >
                                    {u.role === 'CUSTOMER' && <ShoppingBag className="w-3 h-3" />}
                                    {u.role === 'FULFILLMENT_STAFF' && <Package className="w-3 h-3" />}
                                    {u.role === 'SUPPORT_STAFF' && <Headphones className="w-3 h-3" />}
                                    {u.role === 'BUSINESS_OWNER' && <Building2 className="w-3 h-3" />}
                                    <span>{u.role.replace(/_/g, ' ')}</span>
                                  </span>

                                  {isCustomer && (
                                    <span className="text-[10px] text-emerald-800 font-bold bg-emerald-100/70 px-1.5 py-0.5 rounded">
                                      Promotable
                                    </span>
                                  )}
                                </div>
                              </td>

                              <td className="py-3 px-4">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  {isCustomer ? (
                                    <>
                                      <button
                                        onClick={() => executeRoleChange(u.id, 'FULFILLMENT_STAFF')}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-xs font-bold transition-all shadow-2xs"
                                        title="Promote customer to Fulfillment Staff"
                                      >
                                        <ArrowUpRight className="w-3 h-3" />
                                        <span>+ Fulfillment</span>
                                      </button>

                                      <button
                                        onClick={() => executeRoleChange(u.id, 'SUPPORT_STAFF')}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-bold transition-all shadow-2xs"
                                        title="Promote customer to Support Staff"
                                      >
                                        <ArrowUpRight className="w-3 h-3" />
                                        <span>+ Support</span>
                                      </button>

                                      <button
                                        onClick={() => executeRoleChange(u.id, 'BUSINESS_OWNER')}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition-all shadow-2xs"
                                        title="Promote customer to Co-Administrator"
                                      >
                                        <ArrowUpRight className="w-3 h-3" />
                                        <span>+ Admin</span>
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      {!isCurrentUser && (
                                        <button
                                          onClick={() => executeRoleChange(u.id, 'CUSTOMER')}
                                          className="inline-flex items-center gap-1 px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-xs font-bold transition-all"
                                          title="Demote staff back to Customer role"
                                        >
                                          <ArrowDownRight className="w-3 h-3 text-rose-600" />
                                          <span>Demote to Customer</span>
                                        </button>
                                      )}

                                      <select
                                        value={u.role}
                                        disabled={isCurrentUser && u.role === 'BUSINESS_OWNER'}
                                        onChange={(e) => executeRoleChange(u.id, e.target.value as UserRole)}
                                        className="px-2 py-1 bg-slate-50 hover:bg-white border border-slate-300 rounded-lg text-xs font-semibold text-slate-800 cursor-pointer"
                                      >
                                        <option value="CUSTOMER">🛍️ Customer (Shopper)</option>
                                        <option value="FULFILLMENT_STAFF">📦 Fulfillment Staff</option>
                                        <option value="SUPPORT_STAFF">🎧 Support Agent</option>
                                        <option value="SALES_STAFF">🏷️ Sales Staff</option>
                                        <option value="BUSINESS_OWNER">👑 Business Owner (Admin)</option>
                                      </select>
                                    </>
                                  )}

                                  <button
                                    onClick={() => {
                                      setPromoteModalUser(u);
                                      setModalTargetRole(
                                        u.role === 'CUSTOMER' ? 'FULFILLMENT_STAFF' : 'CUSTOMER'
                                      );
                                      setModalReason('');
                                    }}
                                    className="p-1 hover:bg-slate-200 text-slate-500 rounded text-xs ml-1"
                                    title="Open detailed promotion/demotion dialog"
                                  >
                                    <Sliders className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </td>

                              <td className="py-3 px-4 max-w-xs">
                                <span className="text-[11px] text-slate-600 leading-tight block">
                                  {u.role === 'CUSTOMER'
                                    ? 'Customer Dashboard & Storefront (Browse, Cart, Orders)'
                                    : u.role === 'FULFILLMENT_STAFF'
                                    ? 'Fulfillment Operations + Customer Dashboard & Storefront'
                                    : u.role === 'SUPPORT_STAFF'
                                    ? 'Customer Support Inbox + Customer Dashboard & Storefront'
                                    : 'All Dashboards (Executive, Ops, Automation, Team)'}
                                </span>
                              </td>

                              <td className="py-3 px-4 text-right">
                                {onSwitchUser && (
                                  <button
                                    onClick={() => onSwitchUser(u)}
                                    title={`Test Login as ${u.name} to view their exact workspace`}
                                    className="px-2.5 py-1 bg-slate-100 hover:bg-slate-900 hover:text-white text-slate-700 rounded-lg text-xs font-semibold transition-colors"
                                  >
                                    Test Login
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
              )}
            </div>
          )}

          {/* SECTION: ORDERS */}
          {activeMenu === 'orders' && renderOrderStateMachine()}

          {/* SECTION: PRODUCTS OR INVENTORY */}
          {(activeMenu === 'products' || activeMenu === 'inventory') && (
            <div className="space-y-4">
              {activeMenu === 'inventory' && (
                <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">Inventory maintenance</h2>
                    <p className="mt-1 text-xs text-slate-600">Release reservations whose hold period has expired.</p>
                  </div>
                  <button
                    type="button"
                    onClick={onSweepExpired}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Clean expired holds
                  </button>
                </div>
              )}
              {renderInventoryCatalog()}
            </div>
          )}

          {/* SECTION: CUSTOMERS */}
          {activeMenu === 'customers' && (
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs space-y-4">
              <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <h3 className="text-base font-bold text-slate-900">Customers & Role Delegation</h3>
                  <p className="text-xs text-slate-500">
                    Manage customer accounts, promote customers to staff roles, or view lifetime buyer spend.
                  </p>
                </div>

                <div className="inline-flex p-1 bg-slate-100 rounded-xl text-xs font-semibold">
                  <button
                    onClick={() => setCustomerSubTab('rbac')}
                    className={`px-3 py-1.5 rounded-lg transition-all ${
                      customerSubTab === 'rbac'
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Registered Customers & Role Promotion ({users.filter((u) => u.role === 'CUSTOMER').length})
                  </button>
                  <button
                    onClick={() => setCustomerSubTab('vip')}
                    className={`px-3 py-1.5 rounded-lg transition-all ${
                      customerSubTab === 'vip'
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    VIP Profiles & Spending
                  </button>
                </div>
              </div>

              {/* Sub-Tab 1: Registered Accounts & Promotion */}
              {customerSubTab === 'rbac' && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                      <tr>
                        <th className="py-3 px-5">Customer Account</th>
                        <th className="py-3 px-4">Status & Role</th>
                        <th className="py-3 px-4">Promote / Demote Actions</th>
                        <th className="py-3 px-4">Authorized Dashboards</th>
                        <th className="py-3 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {users
                        .filter((u) => u.role === 'CUSTOMER' || !['usr-admin-1'].includes(u.id))
                        .map((u) => {
                          const isCustomer = u.role === 'CUSTOMER';
                          return (
                            <tr key={u.id} className="hover:bg-slate-50/70 transition-colors">
                              <td className="py-3 px-5">
                                <div className="flex items-center gap-3">
                                  <div className="w-8 h-8 rounded-full bg-emerald-600 text-white font-bold text-xs flex items-center justify-center shrink-0">
                                    {u.name
                                      .split(' ')
                                      .map((p) => p[0])
                                      .join('')
                                      .slice(0, 2)
                                      .toUpperCase()}
                                  </div>
                                  <div>
                                    <div className="font-bold text-slate-900">{u.name}</div>
                                    <div className="text-[11px] text-slate-500 font-mono">{u.email}</div>
                                  </div>
                                </div>
                              </td>

                              <td className="py-3 px-4">
                                <span
                                  className={`px-2.5 py-1 rounded-full text-[11px] font-bold border inline-flex items-center gap-1 ${
                                    u.role === 'CUSTOMER'
                                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                      : u.role === 'FULFILLMENT_STAFF'
                                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                                      : 'bg-sky-50 text-sky-700 border-sky-200'
                                  }`}
                                >
                                  {u.role === 'CUSTOMER' ? (
                                    <>
                                      <ShoppingBag className="w-3 h-3" />
                                      <span>CUSTOMER</span>
                                    </>
                                  ) : (
                                    <>
                                      <Package className="w-3 h-3" />
                                      <span>{u.role.replace(/_/g, ' ')}</span>
                                    </>
                                  )}
                                </span>
                              </td>

                              <td className="py-3 px-4">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  {isCustomer ? (
                                    <>
                                      <button
                                        onClick={() => executeRoleChange(u.id, 'FULFILLMENT_STAFF')}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-xs font-bold transition-all shadow-2xs"
                                        title="Promote customer to Fulfillment Staff"
                                      >
                                        <ArrowUpRight className="w-3 h-3" />
                                        <span>+ Fulfillment Staff</span>
                                      </button>

                                      <button
                                        onClick={() => executeRoleChange(u.id, 'SUPPORT_STAFF')}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-bold transition-all shadow-2xs"
                                        title="Promote customer to Support Agent"
                                      >
                                        <ArrowUpRight className="w-3 h-3" />
                                        <span>+ Support Staff</span>
                                      </button>

                                      <button
                                        onClick={() => executeRoleChange(u.id, 'BUSINESS_OWNER')}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition-all shadow-2xs"
                                        title="Promote customer to Business Owner"
                                      >
                                        <ArrowUpRight className="w-3 h-3" />
                                        <span>+ Admin</span>
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      onClick={() => executeRoleChange(u.id, 'CUSTOMER')}
                                      className="inline-flex items-center gap-1 px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-xs font-bold transition-all"
                                      title="Demote staff back to Customer"
                                    >
                                      <ArrowDownRight className="w-3 h-3 text-rose-600" />
                                      <span>Demote to Customer</span>
                                    </button>
                                  )}
                                </div>
                              </td>

                              <td className="py-3 px-4">
                                <span className="text-[11px] text-slate-600">
                                  {u.role === 'CUSTOMER'
                                    ? 'Customer Dashboard & Storefront Only'
                                    : `${u.role.replace(/_/g, ' ')} + Customer Dashboard & Storefront`}
                                </span>
                              </td>

                              <td className="py-3 px-4 text-right">
                                {onSwitchUser && (
                                  <button
                                    onClick={() => onSwitchUser(u)}
                                    className="px-2.5 py-1 bg-slate-100 hover:bg-slate-900 hover:text-white text-slate-700 rounded-lg text-xs font-semibold transition-colors"
                                  >
                                    Test Login
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Sub-Tab 2: VIP Buyer Profiles */}
              {customerSubTab === 'vip' && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                      <tr>
                        <th className="py-3 px-4">Customer</th>
                        <th className="py-3 px-4">Location</th>
                        <th className="py-3 px-4">Tier</th>
                        <th className="py-3 px-4">Total Orders</th>
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
                                className="w-9 h-9 rounded-full object-cover border border-slate-200"
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
              )}
            </div>
          )}

          {/* SECTION: FULFILMENT */}
          {activeMenu === 'fulfilment' && renderFulfillmentView()}

          {/* SECTION: CUSTOMER SUPPORT DESK */}
          {activeMenu === 'support' && renderSupportView && renderSupportView()}

          {/* SECTION: UNIFIED AI SALES ASSISTANT & WHATSAPP CHANNEL */}
          {(activeMenu === 'sales_channels' || activeMenu === 'whatsapp') && (
            <div className="space-y-6">
              {/* Sub-channel switcher */}
              <div className="flex items-center justify-start">
                <div className="inline-flex p-1 bg-slate-100 rounded-xl border border-slate-200 shadow-2xs shrink-0">
                  <button
                    type="button"
                    onClick={() => setConversationalSubTab('assistant')}
                    className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-bold transition-all ${
                      conversationalSubTab === 'assistant'
                        ? 'bg-white text-slate-900 shadow-xs border border-slate-200/80'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Bot className="w-3.5 h-3.5 text-purple-600" />
                    <span>AI Sales Assistant</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setConversationalSubTab('whatsapp')}
                    className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-bold transition-all ${
                      conversationalSubTab === 'whatsapp'
                        ? 'bg-white text-slate-900 shadow-xs border border-slate-200/80'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <MessageSquare className="w-3.5 h-3.5 text-emerald-600" />
                    <span>WhatsApp Channel</span>
                  </button>
                </div>
              </div>

              {/* Render Selected Sub-channel View */}
              <div>
                {conversationalSubTab === 'assistant' ? renderAiAssistantView() : renderWhatsAppView()}
              </div>
            </div>
          )}

          {/* SECTION: ANALYTICS & REPORTS */}
          {activeMenu === 'analytics' && (
            <div className="space-y-6">
              <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs" aria-labelledby="channel-performance-heading">
                <div>
                  <h2 id="channel-performance-heading" className="text-base font-bold text-slate-900">Sales by channel</h2>
                  <p className="mt-1 text-xs text-slate-600">
                    Paid sales and order counts recorded during {dateRange === 'today' ? 'today' : `the last ${dateRange}`}.
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {channelSummaries.map((summary) => (
                    <div key={summary.channel} className="rounded-xl bg-slate-50 p-4">
                      <h3 className="text-xs font-semibold text-slate-700">{channelLabels[summary.channel]}</h3>
                      <p className="mt-2 font-mono text-lg font-bold text-slate-900">
                        {formatCurrency(summary.paidSalesCents, tenant.currency)}
                      </p>
                      <p className="mt-1 text-xs text-slate-600">{summary.orderCount} orders</p>
                    </div>
                  ))}
                </div>
                {periodOrders.every((order) => !order.sourceChannel) && (
                  <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
                    Channel totals are unavailable because these orders do not include channel attribution.
                  </p>
                )}
              </section>
            </div>
          )}

          {/* SECTION: INTEGRATIONS & ADVANCED AUTOMATION (N8N) */}
          {(activeMenu === 'integrations' || activeMenu === 'automation') && (
            <div className="space-y-6">
              <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs space-y-4">
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">
                  Demo environment: connector statuses and controls are local previews, not live service connections.
                </p>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold uppercase tracking-wider inline-flex items-center gap-1">
                        <Layers className="w-3 h-3 text-indigo-600" />
                        Ecosystem & Connectors
                      </span>
                    </div>
                    <h2 className="text-lg font-bold text-slate-900 mt-1">
                      Integrations & Developer Webhooks
                    </h2>
                    <p className="text-xs text-slate-500">
                      Manage commercial connectors or inspect low-level developer automation webhooks (n8n).
                    </p>
                  </div>

                  {/* Sub-tab Switcher between Commercial Connectors and Technical n8n Webhooks */}
                  <div className="inline-flex p-1 bg-slate-100 rounded-xl border border-slate-200 shadow-2xs shrink-0 self-start sm:self-auto">
                    <button
                      type="button"
                      onClick={() => setIntegrationsSubTab('connectors')}
                      className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-bold transition-all ${
                        integrationsSubTab === 'connectors'
                          ? 'bg-white text-slate-900 shadow-xs border border-slate-200/80'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <Layers className="w-3.5 h-3.5 text-blue-600" />
                      <span>Commercial Connectors ({integrations.length})</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setIntegrationsSubTab('automation')}
                      className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-bold transition-all ${
                        integrationsSubTab === 'automation'
                          ? 'bg-white text-slate-900 shadow-xs border border-slate-200/80'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <Bot className="w-3.5 h-3.5 text-purple-600" />
                      <span>Developer Webhooks & n8n</span>
                    </button>
                  </div>
                </div>
              </div>

              {integrationsSubTab === 'connectors' && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {integrations.map((item) => {
                    const isConnected = item.status === 'CONNECTED';
                    return (
                      <div
                        key={item.id}
                        className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs space-y-4 flex flex-col justify-between"
                      >
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                isConnected
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-slate-100 text-slate-500'
                              }`}
                            >
                              {isConnected ? 'Demo connected' : 'Not connected'}
                            </span>
                          </div>
                          <h4 className="font-bold text-sm text-slate-900">{item.name}</h4>
                          <p className="text-xs text-slate-500 leading-relaxed">{item.description}</p>
                        </div>

                        <div className="pt-3 border-t border-slate-100 space-y-2 text-xs">
                          <div className="text-[11px] text-slate-600">
                            Sample connector configuration. No external service is connected.
                          </div>
                          <div className="flex items-center justify-between pt-1">
                            <span className="text-[11px] text-slate-500">Live sync unavailable</span>
                            <button
                              type="button"
                              onClick={() => handleToggleIntegration(item.id)}
                              className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                                isConnected
                                  ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                                  : 'bg-slate-900 text-white hover:bg-slate-800'
                              }`}
                            >
                              {isConnected ? 'Simulate disconnect' : 'Simulate connect'}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {integrationsSubTab === 'automation' && (
                <div className="space-y-4">
                  <div className="p-4 bg-purple-50 border border-purple-200 rounded-2xl flex items-start gap-3 text-xs text-purple-900">
                    <div className="p-2 bg-purple-100 text-purple-700 rounded-xl shrink-0 mt-0.5">
                      <Zap className="w-4 h-4" />
                    </div>
                    <div className="space-y-1">
                      <div className="font-bold text-sm text-purple-950">Technical Developer Hub: n8n & Webhooks</div>
                      <p className="text-purple-800 leading-relaxed">
                        This section represents background plumbing: webhook receivers, event dispatch queues, and JSON payloads. Business owners do not need this for daily commerce, but developers and DevOps can simulate payment events and monitor webhook deliveries here.
                      </p>
                    </div>
                  </div>

                  {renderAutomationView()}
                </div>
              )}
            </div>
          )}

          {/* SECTION: TEAM & PERMISSIONS */}
          {activeMenu === 'team' && (
            <div className="space-y-6">
              {/* Notice Banner */}
              {roleChangeNotice && (
                <div
                  className={`p-4 rounded-2xl border text-xs flex items-center justify-between gap-3 shadow-xs transition-all ${
                    roleChangeNotice.type === 'success'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      : 'bg-red-50 border-red-200 text-red-900'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    {roleChangeNotice.type === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
                    )}
                    <span className="font-semibold">{roleChangeNotice.text}</span>
                  </div>
                  <button
                    onClick={() => setRoleChangeNotice(null)}
                    className="text-slate-400 hover:text-slate-700 text-sm font-bold px-2 py-0.5"
                  >
                    &times;
                  </button>
                </div>
              )}

              {/* Invariant Explanation Banner */}
              <div className="bg-gradient-to-r from-slate-900 to-indigo-950 text-white rounded-2xl p-6 shadow-md border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1.5 max-w-2xl">
                  <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-indigo-500/30 text-indigo-200 text-[11px] font-bold">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Authoritative RBAC Guardrail
                  </div>
                  <h3 className="text-lg font-extrabold tracking-tight">
                    Customer Promotion & Staff Authorization Center
                  </h3>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    All external sign-ups default strictly to <strong>Customer</strong> (Storefront only). Only you, as the <strong>Business Owner (Admin)</strong>, have the authority to grant staff permissions (Fulfillment Staff, Support Staff, or Co-Admin) from these customers.
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => setIsInviteModalOpen(true)}
                    className="px-4 py-2 bg-white text-slate-900 rounded-xl text-xs font-bold hover:bg-slate-100 transition-colors shadow-xs flex items-center gap-2"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Invite / Register User</span>
                  </button>
                </div>
              </div>

              {/* KPI Metrics Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="bg-white border border-slate-200 p-4 rounded-2xl shadow-2xs">
                  <div className="text-[11px] font-semibold text-slate-500 uppercase">Total Accounts</div>
                  <div className="text-2xl font-bold font-mono text-slate-900 mt-1">{users.length}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">In dynamic store</div>
                </div>

                <div className="bg-white border border-slate-200 p-4 rounded-2xl shadow-2xs">
                  <div className="text-[11px] font-semibold text-emerald-700 uppercase">Customers / Shoppers</div>
                  <div className="text-2xl font-bold font-mono text-emerald-700 mt-1">
                    {users.filter((u) => u.role === 'CUSTOMER').length}
                  </div>
                  <div className="text-[11px] text-emerald-600 font-medium mt-0.5">Eligible for promotion</div>
                </div>

                <div className="bg-white border border-slate-200 p-4 rounded-2xl shadow-2xs">
                  <div className="text-[11px] font-semibold text-amber-700 uppercase">Fulfillment Staff</div>
                  <div className="text-2xl font-bold font-mono text-amber-700 mt-1">
                    {users.filter((u) => u.role === 'FULFILLMENT_STAFF').length}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">Warehouse & packing</div>
                </div>

                <div className="bg-white border border-slate-200 p-4 rounded-2xl shadow-2xs">
                  <div className="text-[11px] font-semibold text-indigo-700 uppercase">Support & Admins</div>
                  <div className="text-2xl font-bold font-mono text-indigo-700 mt-1">
                    {users.filter((u) => u.role === 'SUPPORT_STAFF' || u.role === 'BUSINESS_OWNER').length}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">Tickets & executive</div>
                </div>
              </div>

              {/* Table Container */}
              <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs space-y-4">
                <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div>
                    <h3 className="text-base font-bold text-slate-900">Registered Accounts & RBAC Permissions</h3>
                    <p className="text-xs text-slate-500">
                      Promote any customer to staff, adjust roles in real-time, or preview their workspace
                    </p>
                  </div>

                  {/* Filter and Search */}
                  <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
                    <div className="relative flex-1 sm:w-56">
                      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={userSearch}
                        onChange={(e) => setUserSearch(e.target.value)}
                        placeholder="Search name or email..."
                        className="w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 font-medium"
                      />
                    </div>

                    <div className="inline-flex p-1 bg-slate-100 rounded-xl text-xs">
                      <button
                        onClick={() => setUserFilter('all')}
                        className={`px-3 py-1 rounded-lg font-semibold transition-all ${
                          userFilter === 'all'
                            ? 'bg-white text-slate-900 shadow-2xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        All ({users.length})
                      </button>
                      <button
                        onClick={() => setUserFilter('customers')}
                        className={`px-3 py-1 rounded-lg font-semibold transition-all ${
                          userFilter === 'customers'
                            ? 'bg-white text-emerald-800 shadow-2xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Customers ({users.filter((u) => u.role === 'CUSTOMER').length})
                      </button>
                      <button
                        onClick={() => setUserFilter('staff')}
                        className={`px-3 py-1 rounded-lg font-semibold transition-all ${
                          userFilter === 'staff'
                            ? 'bg-white text-indigo-800 shadow-2xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Staff & Admins ({users.filter((u) => u.role !== 'CUSTOMER').length})
                      </button>
                    </div>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                      <tr>
                        <th className="py-3 px-4">User / Account</th>
                        <th className="py-3 px-4">Current Role Badge</th>
                        <th className="py-3 px-4">Grant / Change Permissions</th>
                        <th className="py-3 px-4">Authorized Workspace</th>
                        <th className="py-3 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {users
                        .filter((u) => {
                          if (userFilter === 'customers') return u.role === 'CUSTOMER';
                          if (userFilter === 'staff') return u.role !== 'CUSTOMER';
                          return true;
                        })
                        .filter((u) => {
                          if (!userSearch) return true;
                          const q = userSearch.toLowerCase();
                          return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
                        })
                        .map((u) => {
                          const isCurrentUser = currentUser?.id === u.id;
                          const isCustomer = u.role === 'CUSTOMER';

                          const roleBadgeStyles: Record<UserRole, string> = {
                            CUSTOMER: 'bg-emerald-50 text-emerald-700 border-emerald-200',
                            FULFILLMENT_STAFF: 'bg-amber-50 text-amber-700 border-amber-200',
                            SUPPORT_STAFF: 'bg-sky-50 text-sky-700 border-sky-200',
                            BUSINESS_OWNER: 'bg-indigo-50 text-indigo-700 border-indigo-200',
                            SUPER_ADMIN: 'bg-purple-50 text-purple-700 border-purple-200',
                            SALES_STAFF: 'bg-teal-50 text-teal-700 border-teal-200',
                          };

                          const workspaceDescriptions: Record<UserRole, string> = {
                            CUSTOMER: 'Storefront & Products, Cart, Checkout, Order Tracking',
                            FULFILLMENT_STAFF: 'Fulfillment Operations (Pick queues, laser scan, packing)',
                            SUPPORT_STAFF: 'Customer Support Desk (Tickets, refund authorizations)',
                            BUSINESS_OWNER: 'Full Executive Dashboard, Operations, Team & Access Control',
                            SUPER_ADMIN: 'Full Platform Access & Global Systems',
                            SALES_STAFF: 'Catalog & Sales Assist',
                          };

                          return (
                            <tr key={u.id} className="hover:bg-slate-50/70 transition-colors">
                              <td className="py-3 px-4">
                                <div className="flex items-center gap-3">
                                  <div className="w-8 h-8 rounded-full bg-slate-900 text-white font-bold text-xs flex items-center justify-center shrink-0">
                                    {u.name
                                      .split(' ')
                                      .map((p) => p[0])
                                      .join('')
                                      .slice(0, 2)
                                      .toUpperCase()}
                                  </div>
                                  <div>
                                    <div className="font-bold text-slate-900 flex items-center gap-1.5">
                                      <span>{u.name}</span>
                                      {isCurrentUser && (
                                        <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-slate-200 text-slate-800">
                                          You
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-[11px] text-slate-500 font-mono">{u.email}</div>
                                  </div>
                                </div>
                              </td>

                              <td className="py-3 px-4">
                                <span
                                  className={`px-2.5 py-1 rounded-full text-[11px] font-bold border inline-flex items-center gap-1 ${
                                    roleBadgeStyles[u.role] || 'bg-slate-100 text-slate-700'
                                  }`}
                                >
                                  {u.role === 'CUSTOMER' && <ShoppingBag className="w-3 h-3" />}
                                  {u.role === 'FULFILLMENT_STAFF' && <Package className="w-3 h-3" />}
                                  {u.role === 'SUPPORT_STAFF' && <Headphones className="w-3 h-3" />}
                                  {u.role === 'BUSINESS_OWNER' && <Building2 className="w-3 h-3" />}
                                  <span>{u.role.replace(/_/g, ' ')}</span>
                                </span>
                              </td>

                              <td className="py-3 px-4">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  {isCustomer ? (
                                    <>
                                      <button
                                        onClick={() => executeRoleChange(u.id, 'FULFILLMENT_STAFF')}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-xs font-bold transition-all shadow-2xs"
                                        title="Promote customer to Fulfillment Staff"
                                      >
                                        <ArrowUpRight className="w-3 h-3" />
                                        <span>+ Fulfillment</span>
                                      </button>

                                      <button
                                        onClick={() => executeRoleChange(u.id, 'SUPPORT_STAFF')}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-bold transition-all shadow-2xs"
                                        title="Promote customer to Support Staff"
                                      >
                                        <ArrowUpRight className="w-3 h-3" />
                                        <span>+ Support</span>
                                      </button>

                                      <button
                                        onClick={() => executeRoleChange(u.id, 'BUSINESS_OWNER')}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition-all shadow-2xs"
                                        title="Promote customer to Business Owner"
                                      >
                                        <ArrowUpRight className="w-3 h-3" />
                                        <span>+ Admin</span>
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      {!isCurrentUser && (
                                        <button
                                          onClick={() => executeRoleChange(u.id, 'CUSTOMER')}
                                          className="inline-flex items-center gap-1 px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-xs font-bold transition-all"
                                          title="Demote staff back to Customer role"
                                        >
                                          <ArrowDownRight className="w-3 h-3 text-rose-600" />
                                          <span>Demote to Customer</span>
                                        </button>
                                      )}

                                      <select
                                        value={u.role}
                                        disabled={isCurrentUser && u.role === 'BUSINESS_OWNER'}
                                        onChange={(e) => executeRoleChange(u.id, e.target.value as UserRole)}
                                        className="px-2.5 py-1 bg-slate-50 hover:bg-white border border-slate-300 rounded-lg text-xs font-semibold text-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 cursor-pointer transition-colors shadow-2xs"
                                      >
                                        <option value="CUSTOMER">🛍️ Customer (Shopper)</option>
                                        <option value="FULFILLMENT_STAFF">📦 Fulfillment Staff</option>
                                        <option value="SUPPORT_STAFF">🎧 Support Agent</option>
                                        <option value="SALES_STAFF">🏷️ Sales Staff</option>
                                        <option value="BUSINESS_OWNER">👑 Business Owner (Admin)</option>
                                      </select>
                                    </>
                                  )}

                                  <button
                                    onClick={() => {
                                      setPromoteModalUser(u);
                                      setModalTargetRole(
                                        u.role === 'CUSTOMER' ? 'FULFILLMENT_STAFF' : 'CUSTOMER'
                                      );
                                      setModalReason('');
                                    }}
                                    className="p-1.5 hover:bg-slate-200 text-slate-500 rounded text-xs ml-0.5"
                                    title="Open detailed promotion/demotion dialog"
                                  >
                                    <Sliders className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </td>

                              <td className="py-3 px-4 max-w-xs">
                                <span className="text-[11px] text-slate-600 leading-tight block">
                                  {workspaceDescriptions[u.role]}
                                </span>
                              </td>

                              <td className="py-3 px-4 text-right">
                                {onSwitchUser && (
                                  <button
                                    onClick={() => onSwitchUser(u)}
                                    title={`Log in as ${u.name} to view their role-specific dashboard`}
                                    className="px-3 py-1 bg-slate-100 hover:bg-slate-900 hover:text-white text-slate-700 rounded-lg text-xs font-semibold transition-colors border border-slate-200 shadow-2xs inline-flex items-center gap-1.5"
                                  >
                                    <span>Test Login</span>
                                    <ArrowRight className="w-3 h-3" />
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* RBAC Permission Audit Trail Section */}
              <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-2xs space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <Shield className="w-4 h-4 text-indigo-600" />
                      <span>Immutable RBAC Permissions Audit Log</span>
                    </h3>
                    <p className="text-xs text-slate-500">
                      Audit history of customer signups, promotions, and role modifications
                    </p>
                  </div>
                  <span className="text-[11px] font-mono text-slate-400">
                    {auditLogs.length} events recorded
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider text-[10px]">
                      <tr>
                        <th className="py-2.5 px-3">Timestamp</th>
                        <th className="py-2.5 px-3">Account</th>
                        <th className="py-2.5 px-3">Transition</th>
                        <th className="py-2.5 px-3">Authorized By</th>
                        <th className="py-2.5 px-3">Audit Details / Rationale</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-[11px]">
                      {auditLogs.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-4 text-center text-slate-400 italic">
                            No permission changes recorded yet. Newly promoted customers will appear here.
                          </td>
                        </tr>
                      ) : (
                        auditLogs.slice(0, 8).map((log) => (
                          <tr key={log.id} className="hover:bg-slate-50/60">
                            <td className="py-2.5 px-3 font-mono text-slate-400">
                              {new Date(log.timestamp).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                              })}
                            </td>
                            <td className="py-2.5 px-3 font-semibold text-slate-900">
                              {log.targetUserName}{' '}
                              <span className="font-normal text-slate-400">({log.targetUserEmail})</span>
                            </td>
                            <td className="py-2.5 px-3">
                              <span className="font-mono text-slate-500">{log.previousRole}</span>
                              <span className="text-slate-400 mx-1">&rarr;</span>
                              <span className="font-mono font-bold text-indigo-700">{log.newRole}</span>
                            </td>
                            <td className="py-2.5 px-3 font-medium text-slate-700">
                              {log.grantedByUserName}
                            </td>
                            <td className="py-2.5 px-3 text-slate-500">
                              {log.reason || 'Role updated via Business Owner panel'}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* SECTION: BILLING */}
          {activeMenu === 'billing' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-2xs space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Subscription Plan
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
                    <span className="font-mono font-bold text-slate-900">
                      ${tenant.aiBudgetRemaining.toFixed(2)} / $150.00
                    </span>
                  </div>
                  <div className="w-full bg-slate-200 rounded-full h-2">
                    <div
                      className="bg-purple-600 h-2 rounded-full"
                      style={{ width: `${(tenant.aiBudgetRemaining / 150) * 100}%` }}
                    ></div>
                  </div>
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-2xs space-y-3">
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

          {/* SECTION: SETTINGS */}
          {activeMenu === 'settings' && (
            <form onSubmit={handleSaveSettings} className="bg-white border border-slate-200 rounded-2xl p-6 shadow-2xs space-y-6 max-w-2xl">
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
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-slate-900"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Time guaranteed in cart before stock is released back into available inventory.
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
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-slate-900"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex justify-end">
                <button
                  type="submit"
                  className="px-5 py-2 bg-slate-900 text-white rounded-xl text-xs font-semibold hover:bg-slate-800"
                >
                  Save Configuration
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

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

      {/* 5. PROMOTE / DEMOTE USER MODAL */}
      {promoteModalUser && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-slate-200 space-y-5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-700 flex items-center justify-center border border-indigo-200">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm">
                    {promoteModalUser.role === 'CUSTOMER'
                      ? 'Promote Customer to Staff Role'
                      : 'Adjust / Demote Staff Role'}
                  </h3>
                  <p className="text-xs text-slate-500 font-mono">
                    {promoteModalUser.name} &bull; {promoteModalUser.email}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setPromoteModalUser(null)}
                className="text-slate-400 hover:text-slate-700 text-lg font-bold p-1"
              >
                &times;
              </button>
            </div>

            {/* Current Role Callout */}
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between text-xs">
              <span className="text-slate-600 font-medium">Current Active Role:</span>
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-slate-200 text-slate-800">
                {promoteModalUser.role.replace(/_/g, ' ')}
              </span>
            </div>

            {/* Role Options */}
            <div className="space-y-2 text-xs">
              <label className="block text-slate-700 font-bold">Select New Role Target:</label>

              {/* Option: CUSTOMER */}
              <div
                onClick={() => setModalTargetRole('CUSTOMER')}
                className={`p-3 rounded-xl border cursor-pointer transition-all ${
                  modalTargetRole === 'CUSTOMER'
                    ? 'border-emerald-600 bg-emerald-50/60 ring-1 ring-emerald-600'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-slate-900 flex items-center gap-1.5">
                    <ShoppingBag className="w-3.5 h-3.5 text-emerald-600" />
                    <span>🛍️ Customer (Shopper)</span>
                  </span>
                  {promoteModalUser.role !== 'CUSTOMER' && (
                    <span className="text-[10px] text-rose-700 font-bold bg-rose-100 px-1.5 py-0.2 rounded">
                      Demotion
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-600 leading-relaxed">
                  Storefront, cart, checkout, and tracking only. Revokes all internal staff queues and dashboards.
                </p>
              </div>

              {/* Option: FULFILLMENT_STAFF */}
              <div
                onClick={() => setModalTargetRole('FULFILLMENT_STAFF')}
                className={`p-3 rounded-xl border cursor-pointer transition-all ${
                  modalTargetRole === 'FULFILLMENT_STAFF'
                    ? 'border-amber-600 bg-amber-50/60 ring-1 ring-amber-600'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-slate-900 flex items-center gap-1.5">
                    <Package className="w-3.5 h-3.5 text-amber-600" />
                    <span>📦 Fulfillment Staff</span>
                  </span>
                  {promoteModalUser.role === 'CUSTOMER' && (
                    <span className="text-[10px] text-emerald-800 font-bold bg-emerald-100 px-1.5 py-0.2 rounded">
                      Promotion
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-600 leading-relaxed">
                  Pick-lists, barcode laser verification, packing station slips, carrier dispatch. Dual access: also includes Customer Storefront!
                </p>
              </div>

              {/* Option: SUPPORT_STAFF */}
              <div
                onClick={() => setModalTargetRole('SUPPORT_STAFF')}
                className={`p-3 rounded-xl border cursor-pointer transition-all ${
                  modalTargetRole === 'SUPPORT_STAFF'
                    ? 'border-sky-600 bg-sky-50/60 ring-1 ring-sky-600'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-slate-900 flex items-center gap-1.5">
                    <Headphones className="w-3.5 h-3.5 text-sky-600" />
                    <span>🎧 Customer Support Staff</span>
                  </span>
                  {promoteModalUser.role === 'CUSTOMER' && (
                    <span className="text-[10px] text-emerald-800 font-bold bg-emerald-100 px-1.5 py-0.2 rounded">
                      Promotion
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-600 leading-relaxed">
                  Support ticket inbox, customer 360 lookup, order verification, refund requests. Dual access: also includes Customer Storefront!
                </p>
              </div>

              {/* Option: BUSINESS_OWNER */}
              <div
                onClick={() => setModalTargetRole('BUSINESS_OWNER')}
                className={`p-3 rounded-xl border cursor-pointer transition-all ${
                  modalTargetRole === 'BUSINESS_OWNER'
                    ? 'border-indigo-600 bg-indigo-50/60 ring-1 ring-indigo-600'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-slate-900 flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-indigo-600" />
                    <span>👑 Business Owner (Co-Administrator)</span>
                  </span>
                  {promoteModalUser.role === 'CUSTOMER' && (
                    <span className="text-[10px] text-indigo-800 font-bold bg-indigo-100 px-1.5 py-0.2 rounded">
                      Full Admin
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-600 leading-relaxed">
                  Full executive platform access across all operational, financial, and permissions management tools.
                </p>
              </div>
            </div>

            {/* Optional Reason / Notes */}
            <div className="text-xs">
              <label className="block text-slate-700 font-bold mb-1">
                Audit Trail Rationale / Notes (Optional)
              </label>
              <input
                type="text"
                value={modalReason}
                onChange={(e) => setModalReason(e.target.value)}
                placeholder="e.g. Promoted to lead regional fulfillment station"
                className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setPromoteModalUser(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  executeRoleChange(promoteModalUser.id, modalTargetRole, modalReason)
                }
                className="px-5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-all shadow-xs"
              >
                {modalTargetRole === 'CUSTOMER'
                  ? 'Confirm Demotion to Customer'
                  : `Confirm Promotion to ${modalTargetRole.replace(/_/g, ' ')}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
