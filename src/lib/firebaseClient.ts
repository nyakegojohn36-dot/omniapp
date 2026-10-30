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

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  firebaseUser: FirebaseUser | null = firebaseAuth?.currentUser || null
): Promise<Response> {
  if (import.meta.env.PROD && !apiBaseUrl) {
    throw new Error('Set VITE_API_BASE_URL to the Cloud Run service URL before deploying the frontend.');
  }
  if (!firebaseUser) {
    throw new Error('Sign in before accessing SokoFlow data.');
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${await firebaseUser.getIdToken()}`);
  const url = `${apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  return fetch(url, { ...init, headers });
}
