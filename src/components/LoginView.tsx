import React, { useState } from 'react';
import {
  ArrowRight,
  AlertCircle,
  KeyRound,
  UserPlus,
  LogIn,
  ShieldCheck,
} from 'lucide-react';
import type { PendingBusinessWorkspace, User } from '../lib/types.ts';
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithEmailAndPassword,
  updateProfile,
} from '@firebase/auth';
import { apiFetch, firebaseAuth, isFirebaseConfigured } from '../lib/firebaseClient.ts';

interface AuthOperationProps {
  onAuthOperationStart: () => void;
  onAuthOperationEnd: (startBusiness?: boolean, notice?: string | null) => Promise<void>;
}

interface LoginViewProps extends AuthOperationProps {
  initialMode?: 'signin' | 'signup';
}

interface WorkspaceSetupProps extends AuthOperationProps {
  user: User;
  pendingWorkspace: PendingBusinessWorkspace | null;
  businessSetup: boolean;
  notice: string | null;
  onLogout: () => Promise<void>;
  onCancel?: () => void;
}

/** Recovery is available to authenticated customers even if draft saving failed. */
export function WorkspaceSetupView({ user, pendingWorkspace, businessSetup, notice,
  onAuthOperationStart, onAuthOperationEnd, onLogout, onCancel }: WorkspaceSetupProps) {
  const [businessName, setBusinessName] = useState(pendingWorkspace?.businessName ?? '');
  const [currency, setCurrency] = useState(pendingWorkspace?.currency ?? 'KES');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(notice);
  const identity = firebaseAuth?.currentUser;

  const saveDraft = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!identity || busy) return;
    setBusy(true);
    onAuthOperationStart();
    let result: string | null = null;
    try {
      const response = await apiFetch('/api/onboarding/business/pending', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessName, currency }),
      }, identity);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Could not save business setup.');
      if (!user.emailVerified) result = 'Setup saved to your account. Verify your email, then continue below.';
    } catch (error) {
      result = error instanceof Error ? error.message : 'Could not save business setup.';
    } finally {
      setBusy(false);
      await onAuthOperationEnd(true, result);
    }
  };

  const refreshVerification = async () => {
    if (!identity) return;
    setBusy(true);
    onAuthOperationStart();
    let result: string | null = null;
    try {
      await identity.reload();
      await identity.getIdToken(true);
      if (!identity.emailVerified) result = 'Your email is not verified yet. Open the verification link, then try again.';
    } catch (error) {
      result = error instanceof Error ? error.message : 'Could not check verification.';
    } finally {
      setBusy(false);
      await onAuthOperationEnd(businessSetup, result);
    }
  };

  const resendVerification = async () => {
    if (!identity) return;
    setBusy(true);
    try {
      await sendEmailVerification(identity);
      setMessage('Verification email sent. Check your inbox and spam folder.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not send verification email.');
    } finally { setBusy(false); }
  };

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 p-8 space-y-5 shadow-sm">
        <h1 className="text-2xl font-bold">{businessSetup ? 'Finish business workspace setup' : 'Verify your email'}</h1>
        <p className="text-sm text-slate-600">Signed in as {user.email}. Save your setup details to resume them on another device.</p>
        {message && <p role="status" className="text-sm bg-amber-50 border border-amber-200 rounded-lg p-3">{message}</p>}
        {businessSetup && user.role === 'CUSTOMER' && (
          <form onSubmit={saveDraft} className="space-y-4">
            <label className="block text-sm font-medium">Business name
              <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} required minLength={2} maxLength={80}
                disabled={busy} className="mt-1 block w-full border rounded-lg p-3" />
            </label>
            <label className="block text-sm font-medium">Currency
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={busy} className="mt-1 block w-full border rounded-lg p-3">
                {['KES', 'USD', 'EUR', 'GBP'].map((code) => <option key={code}>{code}</option>)}
              </select>
            </label>
            <p className="text-xs text-slate-500">Your workspace starts with an empty catalogue and no connected WhatsApp or payment provider.</p>
            <button disabled={busy} className="w-full bg-emerald-700 text-white rounded-lg p-3 disabled:opacity-50">
              {user.emailVerified ? 'Create business workspace' : 'Save setup'}
            </button>
          </form>
        )}
        {!user.emailVerified && (
          <div className="space-y-3">
            <p className="text-sm">Email verification is required before continuing.</p>
            <button disabled={busy} onClick={() => void resendVerification()} className="block w-full border rounded-lg p-3 disabled:opacity-50">Resend verification email</button>
            <button disabled={busy} onClick={() => void refreshVerification()} className="block w-full bg-slate-900 text-white rounded-lg p-3 disabled:opacity-50">I've verified my email — continue</button>
          </div>
        )}
        <div className="flex justify-between text-sm">
          {onCancel && <button disabled={busy} onClick={onCancel}>Back to storefront</button>}
          <button disabled={busy} onClick={() => void onLogout()}>Sign out</button>
        </div>
      </div>
    </main>
  );
}

export const LoginView: React.FC<LoginViewProps> = ({
  onAuthOperationStart,
  onAuthOperationEnd,
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

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setSignInError(null);
    if (!firebaseAuth) {
      setSignInError('Firebase Authentication is not configured for this app.');
      return;
    }
    setIsSubmitting(true);
    onAuthOperationStart();
    try {
      const credential = await signInWithEmailAndPassword(
        firebaseAuth,
        signInEmail.trim(),
        signInPassword
      );
      await credential.user.getIdToken(true);
    } catch (error) {
      setSignInError(error instanceof Error ? error.message : 'Sign-in failed. Please try again.');
    } finally {
      setIsSubmitting(false);
      await onAuthOperationEnd();
    }
  };

  const handleSignUpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
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
    const isBusiness = signupMode === 'business';
    let accountCreated = false;
    let notice: string | null = null;
    onAuthOperationStart();
    try {
      const credential = await createUserWithEmailAndPassword(
        firebaseAuth,
        signupEmail.trim(),
        signupPassword
      );
      accountCreated = true;
      await updateProfile(credential.user, { displayName: signupName.trim() });
      await credential.user.getIdToken(true);
      if (isBusiness) {
        const response = await apiFetch('/api/onboarding/business/pending', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ businessName: businessName.trim(), currency: businessCurrency }),
        }, credential.user);
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || 'Business setup could not be saved. Retry from workspace setup.');
      }
      notice = 'Check your email for a verification link. You can continue setup on any device using this account.';
      try {
        await sendEmailVerification(credential.user);
      } catch (error) {
        notice = 'Your account was created, but the verification email could not be sent. Request another email from workspace setup.';
        console.warn('Email verification notice:', error);
      }
    } catch (error) {
      notice = error instanceof Error ? error.message : 'Could not create your account.';
      setSignupError(notice);
    } finally {
      setIsSubmitting(false);
      await onAuthOperationEnd(accountCreated && isBusiness, accountCreated ? notice : null);
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
              disabled={isSubmitting}
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
              disabled={isSubmitting}
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
                disabled={isSubmitting}
                aria-pressed={signupMode === 'customer'}
                onClick={() => setSignupMode('customer')}
                className={`px-4 py-2 text-xs font-semibold rounded-lg ${signupMode === 'customer' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                Customer account
              </button>
              <button
                type="button"
                disabled={isSubmitting}
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
                    ? 'Your verified account becomes the first Business Owner. Your catalogue starts empty. WhatsApp and online payments remain disconnected until authorized integrations are configured.'
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

            <form onSubmit={handleSignUpSubmit}>
              <fieldset disabled={isSubmitting} className="space-y-4">
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
              </fieldset>
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

              <form onSubmit={handleCredentialsSubmit}>
                <fieldset disabled={isSubmitting} className="space-y-4">
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
                </fieldset>
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
