import { getApp, getApps, initializeApp } from '@firebase/app';
import {
  getAuth,
  type Auth,
  type User as FirebaseUser,
} from '@firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const isFirebaseConfigured = Object.values(firebaseConfig).every(Boolean);

const firebaseApp = isFirebaseConfigured
  ? getApps().length > 0
    ? getApp()
    : initializeApp(firebaseConfig)
  : null;

export const firebaseAuth: Auth | null = firebaseApp ? getAuth(firebaseApp) : null;

function getApiBaseUrl(): string {
  const raw = import.meta.env.VITE_API_BASE_URL;
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed.replace(/\/+$/, '');
  }
  return '';
}

const apiBaseUrl = getApiBaseUrl();

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  firebaseUser: FirebaseUser | null = firebaseAuth?.currentUser || null
): Promise<Response> {

  if (!firebaseUser) {
    throw new Error('Sign in before accessing SokoFlow data.');
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${await firebaseUser.getIdToken()}`);
  const url = `${apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  return fetch(url, { ...init, headers });
}
