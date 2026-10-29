import React from 'react';
import { Building2, UserCircle, Shield, Globe } from 'lucide-react';
import { Tenant, UserRole } from '../lib/types.ts';

interface WorkspaceToolbarProps {
  tenants: Tenant[];
  currentTenant: Tenant;
  onSelectTenant: (tenant: Tenant) => void;
  currentRole: UserRole;
  onSelectRole: (role: UserRole) => void;
}

const ROLES: { id: UserRole; label: string; desc: string }[] = [
  { id: 'BUSINESS_OWNER', label: 'Business Owner', desc: 'Full admin, policy & catalog control' },
  { id: 'FULFILLMENT_STAFF', label: 'Fulfillment Staff', desc: 'Pick, pack, ship & warehouse movements' },
  { id: 'SUPPORT_STAFF', label: 'Support Agent', desc: 'Customer tickets & escalated cases' },
  { id: 'CUSTOMER', label: 'Customer', desc: 'Browsing, chat & order placement' },
];

export const WorkspaceToolbar: React.FC<WorkspaceToolbarProps> = ({
  tenants,
  currentTenant,
  onSelectTenant,
  currentRole,
  onSelectRole,
}) => {
  return (
    <div className="bg-slate-50 border-b border-slate-200 py-2.5 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4 text-xs">
        {/* Left: Tenant and Regional Settings */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-slate-500 font-medium">
            <Building2 className="w-3.5 h-3.5 text-slate-400" />
            <span>Active Tenant:</span>
          </div>
          <select
            value={currentTenant.id}
            onChange={(e) => {
              const selected = tenants.find((t) => t.id === e.target.value);
              if (selected) onSelectTenant(selected);
            }}
            className="bg-white border border-slate-300 rounded-md px-2.5 py-1 text-slate-800 font-semibold focus:outline-none focus:ring-1 focus:ring-slate-900"
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.currency} · {t.locale})
              </option>
            ))}
          </select>

          <div className="hidden sm:flex items-center gap-2 text-slate-500">
            <span aria-hidden="true">·</span>
            <span className="flex items-center gap-1 font-mono">
              <Globe className="w-3 h-3 text-slate-400" />
              {currentTenant.timezone}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Tax: {currentTenant.taxRatePercent}% ({currentTenant.taxInclusive ? 'Inclusive' : 'Exclusive'})
            </span>
          </div>
        </div>

        {/* Right: Role-Based Perspective Switcher */}
        <div className="flex items-center gap-3">
          {currentRole === 'CUSTOMER' && (
            <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100/80 text-emerald-900 border border-emerald-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-pulse"></span>
              Customer Access: Storefront & Catalog Only
            </span>
          )}

          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-slate-500 font-medium">
              <Shield className="w-3.5 h-3.5 text-slate-400" />
              <span>Acting Persona:</span>
            </span>
            <div className="flex items-center gap-1 p-0.5 bg-slate-200/80 rounded-lg">
              {ROLES.map((r) => (
                <button
                  key={r.id}
                  onClick={() => onSelectRole(r.id)}
                  title={r.desc}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                    currentRole === r.id
                      ? 'bg-white text-slate-900 shadow-xs font-semibold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
