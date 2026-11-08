import React, { useState } from 'react';
import {
  ArrowRight,
  AlertCircle,
  KeyRound,
  UserPlus,
  LogIn,
  ShieldCheck,
} from 'lucide-react';
import type { Tenant, User } from '../lib/types.ts';
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User as FirebaseAuthUser,
} from '@firebase/auth';
import { apiFetch, firebaseAuth, isFirebaseConfigured } from '../lib/firebaseClient.ts';

const PENDING_BUSINESS_WORKSPACE_KEY = 'sokoflow.pending-business-workspace';

interface PendingBusinessWorkspace {
  email: string;
  businessName: string;
  currency: string;
}

interface LoginViewProps {
  onSelectTenant: (tenant: Tenant) => void;
  onLogin: (user: User) => void;
  initialMode?: 'signin' | 'signup';
}

export const LoginView: React.FC<LoginViewProps> = ({
  onSelectTenant,
  onLogin,
  initialMode = 'signin',
}) => {
  const [pageMode, setPageMode] = useState<'signin' | 'signup'>(initialMode);
  const [signupMode, setSignupMode] = useState<'customer' | 'business'>('customer');

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
  const [businessName, setBusinessName] = useState('');
  const [businessCurrency, setBusinessCurrency] = useState('KES');
  const [signupError, setSignupError] = useState<string | null>(null);
  const [signupNotice, setSignupNotice] = useState<string | null>(null);

  const loadProfile = async (firebaseUser: FirebaseAuthUser) => {
    let pendingWorkspace: PendingBusinessWorkspace | null = null;
    try {
      pendingWorkspace = JSON.parse(
        window.localStorage.getItem(PENDING_BUSINESS_WORKSPACE_KEY) || 'null'
      );
    } catch {
      window.localStorage.removeItem(PENDING_BUSINESS_WORKSPACE_KEY);
    }

    if (pendingWorkspace && pendingWorkspace.email === firebaseUser.email?.trim().toLowerCase()) {
      if (!firebaseUser.emailVerified) {
        if (firebaseAuth) await signOut(firebaseAuth);
        throw new Error('Verify your email address before finishing workspace setup.');
      }
      await firebaseUser.getIdToken(true);
      const onboardingResponse = await apiFetch('/api/onboarding/business', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName: pendingWorkspace.businessName,
          currency: pendingWorkspace.currency,
        }),
      }, firebaseUser);
      const onboardingData = await onboardingResponse.json();
      if (!onboardingResponse.ok || !onboardingData?.user || !onboardingData?.tenant) {
        throw new Error(onboardingData?.error || 'Could not create your business workspace.');
      }
      window.localStorage.removeItem(PENDING_BUSINESS_WORKSPACE_KEY);
      onSelectTenant(onboardingData.tenant as Tenant);
      onLogin(onboardingData.user as User);
      return onboardingData.user as User;
    }
    const response = await apiFetch('/api/auth/me', {}, firebaseUser);
    const data = await response.json();
    if (!response.ok || !data?.user) {
      throw new Error(data?.error || 'Could not load your SokoFlow account.');
    }
    const user = data.user as User;
    const tenantResponse = await apiFetch('/api/tenant', {}, firebaseUser);
    const tenantData = await tenantResponse.json();
    if (!tenantResponse.ok || !tenantData?.tenant) {
      throw new Error(tenantData?.error || 'Could not load your business workspace.');
    }
    onSelectTenant(tenantData.tenant as Tenant);
    onLogin(user);
    return user;
  };

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSignInError(null);
    if (!firebaseAuth) {
      setSignInError('Firebase Authentication is not configured for this app.');
      return;
    }
    setIsSubmitting(true);
    try {
      const credential = await signInWithEmailAndPassword(
        firebaseAuth,
        signInEmail.trim(),
        signInPassword
      );
      let pendingWorkspace: PendingBusinessWorkspace | null = null;
      try {
        pendingWorkspace = JSON.parse(
          window.localStorage.getItem(PENDING_BUSINESS_WORKSPACE_KEY) || 'null'
        );
      } catch {
        window.localStorage.removeItem(PENDING_BUSINESS_WORKSPACE_KEY);
      }
      if (
        pendingWorkspace?.email === credential.user.email?.trim().toLowerCase() &&
        !credential.user.emailVerified
      ) {
        await sendEmailVerification(credential.user);
        await signOut(firebaseAuth);
        throw new Error('A verification email was sent. Verify your address, then sign in again to finish workspace setup.');
      }
      if (!credential.user.emailVerified && import.meta.env.VITE_REQUIRE_EMAIL_VERIFIED === 'true') {
        await signOut(firebaseAuth);
        throw new Error('Verify your email address using the link we sent before signing in.');
      }
      await loadProfile(credential.user);
    } catch (error) {
      setSignInError(error instanceof Error ? error.message : 'Sign-in failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignUpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSignupError(null);

    if (signupPassword && signupConfirmPassword && signupPassword !== signupConfirmPassword) {
      setSignupError('Passwords do not match. Please verify.');
      return;
    }
    if (signupMode === 'business' && businessName.trim().length < 2) {
      setSignupError('Enter a business name with at least two characters.');
      return;
    }
    if (!firebaseAuth) {
      setSignupError('Firebase Authentication is not configured for this app.');
      return;
    }

    setIsSubmitting(true);
    try {
      const credential = await createUserWithEmailAndPassword(
        firebaseAuth,
        signupEmail.trim(),
        signupPassword
      );
      await updateProfile(credential.user, { displayName: signupName.trim() });
      if (signupMode === 'business') {
        window.localStorage.setItem(PENDING_BUSINESS_WORKSPACE_KEY, JSON.stringify({
          email: signupEmail.trim().toLowerCase(),
          businessName: businessName.trim(),
          currency: businessCurrency,
        } satisfies PendingBusinessWorkspace));
      }
      let verificationSent = true;
      try {
        await sendEmailVerification(credential.user);
      } catch (error) {
        verificationSent = false;
        console.warn('Email verification notice:', error);
      }
      if (signupMode === 'business') {
        await signOut(firebaseAuth);
        setSignupNotice(verificationSent
          ? 'Verify your email, then sign in with this address to finish creating your business workspace.'
          : 'Your account was created, but the verification email could not be sent. Sign in to request another email.');
      } else if (import.meta.env.VITE_REQUIRE_EMAIL_VERIFIED === 'true') {
        await signOut(firebaseAuth);
        setSignupNotice('Check your email and verify your address. You can sign in after verification.');
      } else {
        await loadProfile(credential.user);
      }
    } catch (error) {
      setSignupError(error instanceof Error ? error.message : 'Could not create your account.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col justify-between text-slate-900 selection:bg-slate-900 selection:text-white">
      {/* Top Header */}
      <header className="border-b border-slate-200 bg-white shadow-2xs">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-slate-900 text-white flex items-center justify-center font-bold text-base shadow-xs">
              SF
            </div>
            <div>
              <div className="text-base font-bold tracking-tight text-slate-900 leading-tight">
                SokoFlow
              </div>
              <div className="text-[11px] text-slate-500 font-medium">
                Every order. Every channel. One clear view.
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
            {pageMode === 'signup'
              ? signupMode === 'business' ? 'Create a business workspace' : 'Create a customer account'
              : 'Sign In to Your Workspace'}
          </h1>
          <p className="mt-2 text-sm text-slate-600 max-w-xl mx-auto">
            {pageMode === 'signup'
              ? signupMode === 'business'
                ? 'Start an isolated workspace for your business. Your account becomes its first owner.'
                : 'Create a customer account to browse a business storefront and manage your orders.'
              : 'Log in with your registered account. You will access only the dashboards authorized for your role.'}
          </p>
          {pageMode === 'signin' && (
            <p className="mt-3 max-w-2xl mx-auto text-sm leading-relaxed text-slate-700">
              Run your business from one place. SokoFlow brings orders, inventory, customer conversations, and fulfilment together—with AI-assisted support to help your team serve customers faster.
            </p>
          )}
          {!isFirebaseConfigured && (
            <p className="mt-4 mx-auto max-w-xl rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-left text-xs text-amber-900">
              Firebase Authentication is not configured. Add the Firebase web app settings to the frontend environment before signing in.
            </p>
          )}

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
                setSignupNotice(null);
              }}
              className={`flex items-center gap-2 px-5 py-2.5 text-xs font-bold rounded-lg transition-all ${
                pageMode === 'signup'
                  ? 'bg-emerald-600 text-white shadow-xs'
                  : 'text-slate-700 hover:text-slate-900'
              }`}
            >
              <UserPlus className="w-4 h-4" />
              <span>Sign Up</span>
              <span className="px-1.5 py-0.2 rounded text-[10px] bg-emerald-500/40 text-emerald-100 font-bold">
                New
              </span>
            </button>
          </div>
          {pageMode === 'signup' && (
            <div className="mt-4 inline-flex p-1 bg-white border border-slate-200 rounded-xl" role="group" aria-label="Account type">
              <button
                type="button"
                aria-pressed={signupMode === 'customer'}
                onClick={() => setSignupMode('customer')}
                className={`px-4 py-2 text-xs font-semibold rounded-lg ${signupMode === 'customer' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                Customer account
              </button>
              <button
                type="button"
                aria-pressed={signupMode === 'business'}
                onClick={() => setSignupMode('business')}
                className={`px-4 py-2 text-xs font-semibold rounded-lg ${signupMode === 'business' ? 'bg-emerald-700 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                Business workspace
              </button>
            </div>
          )}
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
                  {signupMode === 'business' ? 'Business workspace setup' : 'Customer registration'}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {signupMode === 'business'
                    ? 'A private workspace with an empty catalogue and unconnected integrations.'
                    : 'Creates an account for a business storefront and order history.'}
                </p>
              </div>
            </div>

            {/* Invariant Explanation Banner */}
            <div className="mb-6 p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <span className="font-bold text-emerald-900">
                  {signupMode === 'business' ? 'Workspace boundaries:' : 'Account permissions:'}
                </span>
                <p className="text-emerald-800 text-[11px] leading-relaxed">
                  {signupMode === 'business'
                    ? 'Your verified account becomes the first Business Owner. Your catalogue starts empty. WhatsApp stays in demo mode and online payments stay disabled until they are configured.'
                    : <>Self-registration creates a <strong>Customer</strong> account. Staff access is granted by the Business Owner for that workspace.</>}
                </p>
              </div>
            </div>

            {signupError && (
              <div className="mb-4 p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{signupError}</span>
              </div>
            )}

            {signupNotice && (
              <div className="mb-4 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium">
                {signupNotice}
              </div>
            )}

            <form onSubmit={handleSignUpSubmit} className="space-y-4">
              {signupMode === 'business' && (
                <>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1" htmlFor="business-name">
                      Business / workspace name
                    </label>
                    <input
                      id="business-name"
                      type="text"
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      placeholder="e.g. Acacia Market"
                      minLength={2}
                      maxLength={80}
                      required
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white font-medium"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1" htmlFor="business-currency">
                      Workspace currency
                    </label>
                    <select
                      id="business-currency"
                      value={businessCurrency}
                      onChange={(e) => setBusinessCurrency(e.target.value)}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white font-medium"
                    >
                      <option value="KES">KES - Kenyan Shilling</option>
                      <option value="USD">USD - US Dollar</option>
                      <option value="EUR">EUR - Euro</option>
                      <option value="GBP">GBP - Pound Sterling</option>
                    </select>
                  </div>
                </>
              )}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {signupMode === 'business' ? 'Your name' : 'Full Name'}
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
                <span>Initial role:</span>
                <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded font-bold">
                  {signupMode === 'business' ? 'BUSINESS OWNER' : 'CUSTOMER'}
                </span>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-colors shadow-xs"
              >
                {isSubmitting ? (
                  <span>{signupMode === 'business' ? 'Creating Business Account...' : 'Registering Customer Account...'}</span>
                ) : (
                  <>
                    <span>{signupMode === 'business' ? 'Create Business Workspace' : 'Create Customer Account'}</span>
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
                  Create an account
                </button>
              </div>
            </div>

          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-4 px-4 sm:px-6 text-xs text-slate-500">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>&copy; 2026 SokoFlow · Every order. Every channel. One clear view.</span>
          <div className="flex items-center gap-3">
            <span>Shop invoices, not KRA fiscal receipts</span>
            <span aria-hidden="true">·</span>
            <span>M-PESA STK Push when Daraja is configured</span>
            <span aria-hidden="true">·</span>
            <span>TLS in transit</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
