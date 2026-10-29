import React, { useState, useRef, useEffect } from 'react';
import { LogOut, Zap, Shield, ChevronDown } from 'lucide-react';
import { Tenant, User, UserRole } from '../lib/types.ts';
import { ROLE_PERMISSIONS, TabId } from '../lib/permissions.ts';

interface TopBarProps {
  activeTab: string;
  onSelectTab: (tab: string) => void;
  currentTenant: Tenant;
  currentRole: UserRole;
  currentUser?: User | null;
  onLogout?: () => void;
  onOpenSignUp?: () => void;
  onOpenConcurrencyModal: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  currentTenant,
  currentRole,
  currentUser,
  onLogout,
  onOpenConcurrencyModal,
}) => {
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsProfileMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsProfileMenuOpen(false);
      }
    }
    if (isProfileMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isProfileMenuOpen]);
  const roleBadges: Record<UserRole, { label: string; style: string }> = {
    CUSTOMER: {
      label: 'Customer',
      style: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    },
    FULFILLMENT_STAFF: {
      label: 'Fulfilment Staff',
      style: 'bg-amber-50 text-amber-700 border-amber-200',
    },
    SUPPORT_STAFF: {
      label: 'Support Agent',
      style: 'bg-sky-50 text-sky-700 border-sky-200',
    },
    BUSINESS_OWNER: {
      label: 'Business Owner',
      style: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    },
    SUPER_ADMIN: {
      label: 'Super Admin',
      style: 'bg-purple-50 text-purple-700 border-purple-200',
    },
    SALES_STAFF: {
      label: 'Sales Staff',
      style: 'bg-teal-50 text-teal-700 border-teal-200',
    },
  };

  const badge = roleBadges[currentRole] || {
    label: currentRole,
    style: 'bg-slate-100 text-slate-700 border-slate-200',
  };

  const userInitials = currentUser?.name
    ? currentUser.name
        .split(' ')
        .map((p) => p[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : 'U';

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-slate-200 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-6">
        {/* Zone 1: Brand wordmark & Active Store context */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center font-bold text-sm tracking-tight shadow-xs">
            OC
          </div>
          <div className="flex flex-col">
            <span className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap leading-none">
              OmniCommerce AI
            </span>
            <span className="text-[10px] text-slate-500 font-medium tracking-tight mt-0.5 flex items-center gap-1">
              <span>{currentTenant.name}</span>
              <span>·</span>
              <span className="font-mono">{currentTenant.currency}</span>
            </span>
          </div>
        </div>

        {/* Zone 2: Navigation Links Strictly Filtered by Role */}
        <nav className="hidden md:flex items-center gap-5 text-sm font-medium text-slate-600">
          {/* Customer only sees Storefront & Catalog */}
          {ROLE_PERMISSIONS[currentRole].allowedTabs.includes('storefront') && (
            <button
              onClick={() => onSelectTab('storefront')}
              className={`whitespace-nowrap shrink-0 transition-colors py-1 ${
                activeTab === 'storefront'
                  ? 'text-slate-900 font-semibold border-b-2 border-slate-900'
                  : 'hover:text-slate-900'
              }`}
            >
              {currentRole === 'CUSTOMER'
                ? 'Storefront & Products'
                : currentRole === 'FULFILLMENT_STAFF' || currentRole === 'SUPPORT_STAFF'
                ? 'Customer Dashboard & Storefront'
                : 'Storefront Preview'}
            </button>
          )}

          {/* Overview Tab label tailored by Role */}
          {ROLE_PERMISSIONS[currentRole].allowedTabs.includes('overview') && (
            <button
              onClick={() => onSelectTab('overview')}
              className={`whitespace-nowrap shrink-0 transition-colors py-1 ${
                activeTab === 'overview'
                  ? 'text-slate-900 font-semibold border-b-2 border-slate-900'
                  : 'hover:text-slate-900'
              }`}
            >
              {currentRole === 'FULFILLMENT_STAFF'
                ? 'Fulfilment Operations'
                : 'Admin Dashboard'}
            </button>
          )}

          {/* Customer Support Desk Tab */}
          {ROLE_PERMISSIONS[currentRole].allowedTabs.includes('support') && (
            <button
              onClick={() => onSelectTab('support')}
              className={`whitespace-nowrap shrink-0 transition-colors py-1 ${
                activeTab === 'support'
                  ? 'text-slate-900 font-semibold border-b-2 border-slate-900'
                  : 'hover:text-slate-900'
              }`}
            >
              Support Desk
            </button>
          )}

          {/* Inventory tab - accessible only to roles permitted */}
          {ROLE_PERMISSIONS[currentRole].allowedTabs.includes('inventory') && currentRole !== 'CUSTOMER' && (
            <button
              onClick={() => onSelectTab('inventory')}
              className={`whitespace-nowrap shrink-0 transition-colors py-1 ${
                activeTab === 'inventory'
                  ? 'text-slate-900 font-semibold border-b-2 border-slate-900'
                  : 'hover:text-slate-900'
              }`}
            >
              {currentRole === 'FULFILLMENT_STAFF' ? 'Inventory & Locations' : 'Inventory & Catalog'}
            </button>
          )}

          {/* Orders state machine tab */}
          {ROLE_PERMISSIONS[currentRole].allowedTabs.includes('orders') && (
            <button
              onClick={() => onSelectTab('orders')}
              className={`whitespace-nowrap shrink-0 transition-colors py-1 ${
                activeTab === 'orders'
                  ? 'text-slate-900 font-semibold border-b-2 border-slate-900'
                  : 'hover:text-slate-900'
              }`}
            >
              {currentRole === 'SUPPORT_STAFF' ? 'Orders Lookup' : 'Order State Machine'}
            </button>
          )}

          {/* Unified AI & WhatsApp Sales */}
          {(ROLE_PERMISSIONS[currentRole].allowedTabs.includes('ai-sales') ||
            ROLE_PERMISSIONS[currentRole].allowedTabs.includes('ai-assistant') ||
            ROLE_PERMISSIONS[currentRole].allowedTabs.includes('whatsapp')) && (
            <button
              onClick={() => onSelectTab('ai-sales')}
              className={`whitespace-nowrap shrink-0 transition-colors py-1 ${
                activeTab === 'ai-sales' || activeTab === 'ai-assistant' || activeTab === 'whatsapp'
                  ? 'text-slate-900 font-semibold border-b-2 border-slate-900'
                  : 'hover:text-slate-900'
              }`}
            >
              AI & WhatsApp Sales
            </button>
          )}
        </nav>

        {/* Zone 3: User Profile & Role Identity & Sign Out */}
        <div className="flex items-center gap-3 shrink-0">

          {/* Interactive User Profile & Dropdown with Sign Out */}
          {currentUser && (
            <div className="relative pl-2 border-l border-slate-200" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setIsProfileMenuOpen((prev) => !prev)}
                className={`flex items-center gap-2.5 p-1.5 sm:px-2.5 sm:py-1.5 rounded-xl transition-all cursor-pointer border ${
                  isProfileMenuOpen
                    ? 'bg-slate-100 border-slate-300 ring-2 ring-slate-900/10'
                    : 'border-transparent hover:border-slate-200 hover:bg-slate-100/80'
                }`}
                title="Click to view profile and sign out"
                aria-expanded={isProfileMenuOpen}
                aria-haspopup="true"
              >
                <div className="w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center font-bold text-xs shadow-xs shrink-0">
                  {userInitials}
                </div>
                <div className="hidden sm:flex flex-col text-left min-w-0 max-w-[130px]">
                  <div className="flex items-center gap-1.5 truncate">
                    <span className="text-xs font-bold text-slate-900 leading-none truncate">
                      {currentUser.name}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-500 font-mono mt-0.5 leading-none truncate">
                    {badge.label}
                  </span>
                </div>
                <ChevronDown
                  className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 shrink-0 ${
                    isProfileMenuOpen ? 'rotate-180 text-slate-700' : ''
                  }`}
                />
              </button>

              {/* Profile Dropdown Menu */}
              {isProfileMenuOpen && (
                <div className="absolute right-0 top-full mt-2 w-72 bg-white rounded-2xl shadow-xl border border-slate-200 py-1.5 z-50 animate-in fade-in zoom-in-95 duration-150">
                  {/* User Identity Details */}
                  <div className="px-4 py-3 border-b border-slate-100">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-slate-900 text-white font-bold text-sm flex items-center justify-center shrink-0 shadow-xs">
                        {userInitials}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold text-slate-900 truncate">
                          {currentUser.name}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono truncate">
                          {currentUser.email}
                        </div>
                      </div>
                    </div>

                    <div className="mt-2.5 flex items-center justify-between">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border inline-flex items-center gap-1 ${badge.style}`}>
                        <Shield className="w-3 h-3" />
                        <span>{badge.label}</span>
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">
                        {currentTenant.currency}
                      </span>
                    </div>
                  </div>

                  {/* Active Store Context */}
                  <div className="px-4 py-2 text-[11px] text-slate-500 bg-slate-50/70 border-b border-slate-100">
                    <span className="text-slate-400">Store Context: </span>
                    <strong className="text-slate-700 font-semibold">{currentTenant.name}</strong>
                  </div>

                  {/* Diagnostic tools for Admin */}
                  {ROLE_PERMISSIONS[currentRole].canTriggerConcurrencyTest && (
                    <div className="p-1.5 border-b border-slate-100">
                      <button
                        type="button"
                        onClick={() => {
                          setIsProfileMenuOpen(false);
                          onOpenConcurrencyModal();
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-slate-700 hover:text-slate-900 hover:bg-slate-50 transition-colors text-left group cursor-pointer"
                      >
                        <div className="w-7 h-7 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center shrink-0 group-hover:bg-amber-100 transition-colors">
                          <Zap className="w-3.5 h-3.5" />
                        </div>
                        <div>
                          <div className="font-bold">System Diagnostics</div>
                          <div className="text-[10px] text-slate-400 font-normal">Atomic stock concurrency runner</div>
                        </div>
                      </button>
                    </div>
                  )}

                  {/* Dropdown Options: Sign Out */}
                  {onLogout && (
                    <div className="p-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setIsProfileMenuOpen(false);
                          onLogout();
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-rose-600 hover:text-rose-700 hover:bg-rose-50 transition-colors text-left group cursor-pointer"
                      >
                        <div className="w-7 h-7 rounded-lg bg-rose-100/70 text-rose-600 flex items-center justify-center shrink-0 group-hover:bg-rose-200/70 transition-colors">
                          <LogOut className="w-3.5 h-3.5" />
                        </div>
                        <div>
                          <div className="font-bold">Sign Out</div>
                          <div className="text-[10px] text-slate-400 font-normal">Return to authentication gate</div>
                        </div>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Mobile Nav Tabs Bar (Filtered strictly by Role) */}
      <div className="md:hidden flex items-center gap-1 overflow-x-auto px-4 py-2 border-t border-slate-100 bg-slate-50/50 text-xs">
        {ROLE_PERMISSIONS[currentRole].allowedTabs.map((tabId: TabId) => {
          if (currentRole === 'CUSTOMER' && tabId === 'inventory') return null;
          // Avoid duplicate mobile tabs for combined sales channels and technical developer webhooks
          if (tabId === 'ai-assistant' || tabId === 'whatsapp' || tabId === 'automation') return null;
          const labels: Record<string, string> = {
            storefront:
              currentRole === 'CUSTOMER'
                ? 'Storefront'
                : currentRole === 'FULFILLMENT_STAFF' || currentRole === 'SUPPORT_STAFF'
                ? 'Customer View'
                : 'Storefront Preview',
            overview:
              currentRole === 'FULFILLMENT_STAFF'
                ? 'Fulfilment'
                : 'Dashboard',
            support: 'Support Desk',
            inventory: currentRole === 'FULFILLMENT_STAFF' ? 'Inventory Locations' : 'Inventory',
            orders: currentRole === 'SUPPORT_STAFF' ? 'Orders Lookup' : 'Orders Machine',
            'ai-sales': 'AI & WhatsApp Sales',
          };
          const isActive =
            activeTab === tabId ||
            (tabId === 'ai-sales' && (activeTab === 'ai-assistant' || activeTab === 'whatsapp'));
          return (
            <button
              key={tabId}
              onClick={() => onSelectTab(tabId)}
              className={`px-3 py-1.5 rounded-md whitespace-nowrap font-medium transition-colors ${
                isActive
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600'
              }`}
            >
              {labels[tabId] || tabId}
            </button>
          );
        })}
      </div>
    </header>
  );
};
