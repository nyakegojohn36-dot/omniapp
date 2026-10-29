import React, { useState } from 'react';
import {
  ShoppingBag,
  Package,
  Headphones,
  Building2,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  KeyRound,
  UserPlus,
  LogIn,
  Users,
  ShieldCheck,
  Check,
  Sparkles,
} from 'lucide-react';
import type { Tenant, User, UserRole } from '../lib/types.ts';
import { signUpCustomer, authenticateUser } from '../lib/userStore.ts';

interface LoginViewProps {
  tenants: Tenant[];
  currentTenant: Tenant;
  onSelectTenant: (tenant: Tenant) => void;
  onLogin: (user: User) => void;
  dynamicUsers?: User[];
  onSignUpSuccess?: (user: User) => void;
  initialMode?: 'signin' | 'signup';
}

export const LoginView: React.FC<LoginViewProps> = ({
  tenants,
  currentTenant,
  onSelectTenant,
  onLogin,
  dynamicUsers = [],
  onSignUpSuccess,
  initialMode = 'signin',
}) => {
  const [pageMode, setPageMode] = useState<'signin' | 'signup'>(initialMode);
  const [selectedTenantId, setSelectedTenantId] = useState(currentTenant.id);

  // Sign In credentials state
  const [signInEmail, setSignInEmail] = useState('');
  const [signInPassword, setSignInPassword] = useState('');
  const [signInError, setSignInError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Sign Up form state
  const [signupName, setSignupName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirmPassword, setSignupConfirmPassword] = useState('');
  const [signupError, setSignupError] = useState<string | null>(null);
  const [signupSuccessNotice, setSignupSuccessNotice] = useState<string | null>(null);

  // Direct login with pre-configured persona for fast evaluation
  const handleDirectLogin = (user: User) => {
    const tenant = tenants.find((t) => t.id === selectedTenantId) || currentTenant;
    onSelectTenant(tenant);
    onLogin({ ...user, tenantId: tenant.id });
  };

  const handleCredentialsSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSignInError(null);
    setIsSubmitting(true);

    setTimeout(() => {
      setIsSubmitting(false);
      const auth = authenticateUser(signInEmail, selectedTenantId);

      if (auth.success && auth.user) {
        const tenant = tenants.find((t) => t.id === selectedTenantId) || currentTenant;
        onSelectTenant(tenant);
        onLogin({ ...auth.user, tenantId: tenant.id });
      } else {
        setSignInError(
          auth.error ||
            `No account found matching "${signInEmail}". Please verify or sign up as a new customer.`
        );
      }
    }, 250);
  };

  const handleSignUpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSignupError(null);

    if (signupPassword && signupConfirmPassword && signupPassword !== signupConfirmPassword) {
      setSignupError('Passwords do not match. Please verify.');
      return;
    }

    setIsSubmitting(true);

    setTimeout(() => {
      setIsSubmitting(false);
      // Strictly registers as CUSTOMER (policy invariant)
      const result = signUpCustomer({
        name: signupName,
        email: signupEmail,
        tenantId: selectedTenantId,
        password: signupPassword,
      });

      if (!result.success || !result.user) {
        setSignupError(result.error || 'Failed to create customer account.');
        return;
      }

      setSignupSuccessNotice(
        `Welcome ${result.user.name}! Your verified customer account is ready. Redirecting to your Customer Dashboard...`
      );

      const targetTenant = tenants.find((t) => t.id === selectedTenantId) || currentTenant;
      onSelectTenant(targetTenant);

      if (onSignUpSuccess) {
        onSignUpSuccess(result.user);
      }

      // Immediate redirect to customer dashboard
      setTimeout(() => {
        onLogin(result.user!);
      }, 600);
    }, 300);
  };

  // Demo accounts for quick evaluation
  const defaultAccounts: Array<{
    user: User;
    roleName: string;
    roleBadge: string;
    description: string;
    accessibleDashboards: string[];
  }> = [
    {
      user: dynamicUsers.find((u) => u.role === 'BUSINESS_OWNER') || {
        id: 'usr-admin-1',
        name: 'Alex Mwangi',
        email: 'alex@safaripeak.co.ke',
        role: 'BUSINESS_OWNER',
        tenantId: selectedTenantId,
      },
      roleName: 'Business Owner (Admin)',
      roleBadge: 'bg-indigo-100 text-indigo-900 border-indigo-300',
      description: 'Full administrative access across Safari Peak stores, M-PESA channels, and team permissions.',
      accessibleDashboards: [
        'Executive Dashboard',
        'Customer Storefront',
        'Order State Machine',
        'Inventory & Locations (Nairobi/Mombasa)',
        'AI & WhatsApp Sales',
        'Automations & n8n',
        'Team & RBAC Permissions',
      ],
    },
    {
      user: dynamicUsers.find((u) => u.role === 'FULFILLMENT_STAFF') || {
        id: 'usr-fulfill-1',
        name: 'Marcus Kiprop',
        email: 'marcus.k@safaripeak.co.ke',
        role: 'FULFILLMENT_STAFF',
        tenantId: selectedTenantId,
      },
      roleName: 'Fulfilment Lead',
      roleBadge: 'bg-amber-100 text-amber-900 border-amber-300',
      description: 'Nairobi Industrial Area hub workstation for order picking, scanning, and Sendy/Boda dispatch.',
      accessibleDashboards: [
        'Fulfilment Operations (Pick/Pack/Dispatch)',
        'Customer Dashboard / Storefront',
        'Nairobi & Mombasa Bins',
        'Order Queue Lookup',
      ],
    },
    {
      user: dynamicUsers.find((u) => u.role === 'SUPPORT_STAFF') || {
        id: 'usr-support-1',
        name: 'Elena Wanjiku',
        email: 'elena.w@safaripeak.co.ke',
        role: 'SUPPORT_STAFF',
        tenantId: selectedTenantId,
      },
      roleName: 'Customer Support Lead',
      roleBadge: 'bg-sky-100 text-sky-900 border-sky-300',
      description: 'Omnichannel customer service, M-PESA transaction trace, and authorized refund requests.',
      accessibleDashboards: [
        'Support Inbox & Omnichannel',
        'Customer Dashboard / Storefront',
        'Orders Lookup & Verification',
        'WhatsApp Channel',
      ],
    },
    {
      user: dynamicUsers.find((u) => u.role === 'CUSTOMER') || {
        id: 'usr-cust-1',
        name: 'Sarah Nekesa',
        email: 'sarah.nekesa@gmail.com',
        role: 'CUSTOMER',
        tenantId: selectedTenantId,
      },
      roleName: 'Customer (Shopper)',
      roleBadge: 'bg-emerald-100 text-emerald-900 border-emerald-300',
      description: 'Kenyan shopper browsing products, Lipa na M-PESA checkout, and live Boda delivery tracking.',
      accessibleDashboards: ['Customer Dashboard & Storefront', 'Public Product Catalog & Cart'],
    },
  ];

  // Accounts created or promoted dynamically
  const newlyCreatedAccounts = dynamicUsers.filter(
    (u) => !['usr-admin-1', 'usr-fulfill-1', 'usr-support-1', 'usr-cust-1'].includes(u.id)
  );

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col justify-between text-slate-900 selection:bg-slate-900 selection:text-white">
      {/* Top Header */}
      <header className="border-b border-slate-200 bg-white shadow-2xs">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-slate-900 text-white flex items-center justify-center font-bold text-base shadow-xs">
              OC
            </div>
            <div>
              <div className="text-base font-bold tracking-tight text-slate-900 leading-tight">
                OmniCommerce AI
              </div>
              <div className="text-[11px] text-slate-500 font-medium">
                Enterprise Multi-Tenant Ecommerce Automation
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 py-10 flex flex-col items-center justify-center">
        {/* Page Switcher Header */}
        <div className="w-full text-center mb-8">
          <h1 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
            {pageMode === 'signup' ? 'Create Customer Account' : 'Sign In to Your Workspace'}
          </h1>
          <p className="mt-2 text-sm text-slate-600 max-w-xl mx-auto">
            {pageMode === 'signup'
              ? 'All new users register strictly as Customers. Only the Business Owner (Admin) can promote accounts to Fulfillment Staff, Support Staff, or Admin.'
              : 'Log in with your registered account. You will access only the dashboards authorized for your role.'}
          </p>

          {/* Dedicated Page Toggle Tabs */}
          <div className="mt-6 inline-flex p-1 bg-slate-200 rounded-xl shadow-inner">
            <button
              onClick={() => {
                setPageMode('signin');
                setSignInError(null);
              }}
              className={`flex items-center gap-2 px-5 py-2.5 text-xs font-bold rounded-lg transition-all ${
                pageMode === 'signin'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <LogIn className="w-4 h-4" />
              <span>Sign In</span>
            </button>

            <button
              onClick={() => {
                setPageMode('signup');
                setSignupError(null);
              }}
              className={`flex items-center gap-2 px-5 py-2.5 text-xs font-bold rounded-lg transition-all ${
                pageMode === 'signup'
                  ? 'bg-emerald-600 text-white shadow-xs'
                  : 'text-slate-700 hover:text-slate-900'
              }`}
            >
              <UserPlus className="w-4 h-4" />
              <span>Sign Up as Customer</span>
              <span className="px-1.5 py-0.2 rounded text-[10px] bg-emerald-500/40 text-emerald-100 font-bold">
                New
              </span>
            </button>
          </div>
        </div>

        {/* ======================================================== */}
        {/* PAGE 1: SIGN UP AS CUSTOMER                              */}
        {/* ======================================================== */}
        {pageMode === 'signup' && (
          <div className="w-full max-w-xl bg-white border border-slate-200 rounded-2xl p-8 shadow-xs text-left">
            <div className="flex items-center gap-3 mb-6 pb-4 border-b border-slate-100">
              <div className="w-12 h-12 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-xs">
                <UserPlus className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-900 leading-tight">
                  Customer Registration
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Creates an account with direct access to the Customer Dashboard & Storefront.
                </p>
              </div>
            </div>

            {/* Invariant Explanation Banner */}
            <div className="mb-6 p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <span className="font-bold text-emerald-900">Authoritative RBAC Rule:</span>
                <p className="text-emerald-800 text-[11px] leading-relaxed">
                  Every self-registration is strictly provisioned as a <strong>Customer</strong>. Customers have access exclusively to the Storefront and Customer Dashboard.
                  Staff privileges (Fulfillment Staff, Support Staff, Admin) can only be granted by the <strong>Business Owner (Admin)</strong> from their Team & Permissions dashboard.
                </p>
              </div>
            </div>

            {signupSuccessNotice && (
              <div className="mb-6 p-4 rounded-xl bg-emerald-100 border border-emerald-300 text-emerald-900 text-xs flex items-center gap-3 font-medium">
                <Check className="w-5 h-5 text-emerald-700 shrink-0" />
                <span>{signupSuccessNotice}</span>
              </div>
            )}

            {signupError && (
              <div className="mb-4 p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{signupError}</span>
              </div>
            )}

            <form onSubmit={handleSignUpSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Full Name
                </label>
                <input
                  type="text"
                  value={signupName}
                  onChange={(e) => setSignupName(e.target.value)}
                  placeholder="e.g. John Doe"
                  required
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white font-medium"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Email Address
                </label>
                <input
                  type="email"
                  value={signupEmail}
                  onChange={(e) => setSignupEmail(e.target.value)}
                  placeholder="e.g. john.doe@example.com"
                  required
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white font-medium"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    value={signupPassword}
                    onChange={(e) => setSignupPassword(e.target.value)}
                    placeholder="••••••••••••"
                    required
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white font-medium"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Confirm Password
                  </label>
                  <input
                    type="password"
                    value={signupConfirmPassword}
                    onChange={(e) => setSignupConfirmPassword(e.target.value)}
                    placeholder="••••••••••••"
                    required
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white font-medium"
                  />
                </div>
              </div>

              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-[11px] text-slate-600 flex items-center justify-between">
                <span>Default Initial Role:</span>
                <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded font-bold">
                  CUSTOMER (Verified Shopper)
                </span>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-colors shadow-xs"
              >
                {isSubmitting ? (
                  <span>Registering Customer Account...</span>
                ) : (
                  <>
                    <span>Create Customer Account & Go to Customer Dashboard</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>

            <div className="mt-5 text-center text-xs text-slate-500 pt-3 border-t border-slate-100">
              Already have an account?{' '}
              <button
                onClick={() => {
                  setPageMode('signin');
                  setSignInError(null);
                }}
                className="font-bold text-slate-900 hover:underline"
              >
                Sign In here
              </button>
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* PAGE 2: SIGN IN                                          */}
        {/* ======================================================== */}
        {pageMode === 'signin' && (
          <div className="w-full max-w-2xl space-y-6">
            {/* Credentials Card */}
            <div className="bg-white border border-slate-200 rounded-2xl p-8 shadow-xs text-left">
              <div className="flex items-center gap-3 mb-6 pb-4 border-b border-slate-100">
                <div className="w-12 h-12 rounded-xl bg-slate-900 text-white flex items-center justify-center shrink-0 shadow-xs">
                  <KeyRound className="w-6 h-6 text-amber-400" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-900 leading-tight">
                    Sign In with Email & Password
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Enter your email to access your role-authorized workspace.
                  </p>
                </div>
              </div>

              {signInError && (
                <div className="mb-4 p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2 font-medium">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{signInError}</span>
                </div>
              )}

              <form onSubmit={handleCredentialsSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Registered Email Address
                  </label>
                  <input
                    type="email"
                    value={signInEmail}
                    onChange={(e) => setSignInEmail(e.target.value)}
                    placeholder="e.g. alex@safaripeak.co.ke or sarah.nekesa@gmail.com"
                    required
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:bg-white font-medium"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    value={signInPassword}
                    onChange={(e) => setSignInPassword(e.target.value)}
                    placeholder="••••••••••••"
                    required
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:bg-white font-medium"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-2.5 px-4 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-colors shadow-xs"
                >
                  {isSubmitting ? (
                    <span>Authenticating...</span>
                  ) : (
                    <>
                      <span>Sign In & Access Authorized Dashboard</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>

              <div className="mt-5 text-center text-xs text-slate-500 pt-3 border-t border-slate-100">
                Don't have an account yet?{' '}
                <button
                  onClick={() => {
                    setPageMode('signup');
                    setSignupError(null);
                  }}
                  className="font-bold text-emerald-600 hover:underline"
                >
                  Sign up as a Customer
                </button>
              </div>
            </div>

            {/* Quick Demo Access Bar */}
            <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs text-left space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                  <span>Instant Role Switcher (Pre-configured Kenyan Personas):</span>
                </span>
                <span className="text-[10px] text-slate-400 font-mono">Role Segregated</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {defaultAccounts.map((item) => (
                  <button
                    key={item.user.id}
                    type="button"
                    onClick={() => handleDirectLogin(item.user)}
                    className="p-2.5 rounded-xl border border-slate-200 hover:border-slate-300 bg-slate-50 hover:bg-slate-100 transition-all text-left flex flex-col justify-between group cursor-pointer"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-bold text-xs text-slate-900 group-hover:text-indigo-600 truncate">
                          {item.user.name.split(' ')[0]}
                        </span>
                        <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold border ${item.roleBadge}`}>
                          {item.roleName.replace(' Staff', '').replace(' (Shopper)', '').replace(' (Admin)', '')}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-500 truncate">
                        {item.roleName}
                      </div>
                    </div>
                    <div className="mt-2 text-[10px] font-semibold text-slate-700 group-hover:text-slate-900 flex items-center gap-1">
                      <span>Sign In</span>
                      <ArrowRight className="w-2.5 h-2.5" />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-4 px-4 sm:px-6 text-xs text-slate-500">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>Safari Peak Outfitters Kenya &copy; 2026 · Powered by OmniCommerce Retail OS</span>
          <div className="flex items-center gap-3">
            <span>KRA eTIMS Tax Compliant</span>
            <span aria-hidden="true">·</span>
            <span>Daraja M-PESA Integrated</span>
            <span aria-hidden="true">·</span>
            <span>256-Bit SSL Encrypted</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
