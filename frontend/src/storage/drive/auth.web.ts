import { DRIVE_SCOPE, GOOGLE_WEB_CLIENT_ID } from './config';
import { t } from '@/i18n';
import { DRIVE_CLIENT_ID_KEY, DRIVE_SESSION_KEY, readWebDriveSession, validGoogleClientId, writeWebDriveSession } from './webSession';

interface TokenResponse { access_token?: string; expires_in?: number; scope?: string; error?: string }
interface GoogleIdentity {
  accounts: { oauth2: {
    initTokenClient(config: {
      client_id: string; scope: string; include_granted_scopes: boolean;
      callback: (response: TokenResponse) => void;
      error_callback: () => void;
    }): { requestAccessToken(options: { prompt: string }): void };
  } };
}
let scriptPromise: Promise<void> | null = null;
let token: { clientId: string; value: string; expiresAt: number } | null = null;
let authorizing = false;
const identity = () => (window as unknown as { google?: GoogleIdentity }).google;

function configuredClientId(): string {
  try { return window.localStorage.getItem(DRIVE_CLIENT_ID_KEY) || GOOGLE_WEB_CLIENT_ID; }
  catch { return GOOGLE_WEB_CLIENT_ID; }
}

export async function getDriveClientId(): Promise<string> { return configuredClientId(); }
export async function setDriveClientId(value: string): Promise<void> {
  const id = value.trim();
  if (id && !validGoogleClientId(id)) throw new Error(t('drive.invalidClientId'));
  if (authorizing) throw new Error(t('drive.busy'));
  if (id !== configuredClientId()) await disconnectDriveAuth();
  if (id) window.localStorage.setItem(DRIVE_CLIENT_ID_KEY, id);
  else window.localStorage.removeItem(DRIVE_CLIENT_ID_KEY);
}

function loadIdentity(): Promise<void> {
  if (identity()) return Promise.resolve();
  if (!scriptPromise) scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    const timeout = window.setTimeout(() => { script.remove(); reject(new Error(t('drive.authUnavailable'))); }, 20000);
    script.onload = () => { clearTimeout(timeout); resolve(); };
    script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error(t('drive.authUnavailable'))); };
    document.head.appendChild(script);
  }).catch((error: unknown) => { scriptPromise = null; throw error; });
  return scriptPromise;
}

export function prepareDriveAuth(): void {
  void loadIdentity().catch(() => {});
}

// Page entry attempts the Google flow; a blocked popup requires a user-driven retry.
export function driveEntryAccessToken(): Promise<string> { return driveAccessToken(true); }

export async function driveAccessToken(interactive = false, chooseAccount = false): Promise<string> {
  const clientId = configuredClientId();
  if (!clientId) throw new Error(t('drive.clientIdRequired'));
  if (token?.clientId !== clientId) token = null;
  if (!token) {
    try { token = readWebDriveSession(window.localStorage, clientId); } catch { /* Private browsing. */ }
  }
  if (!chooseAccount && token && token.expiresAt > Date.now() + 60000) return token.value;
  if (!interactive) throw new Error(t('drive.reauthorize'));
  if (authorizing) throw new Error(t('drive.busy'));
  // Preloaded by Settings so requestAccessToken normally runs in the click gesture.
  if (!identity()) await loadIdentity();
  authorizing = true;
  try {
    return await new Promise<string>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error(t('drive.reauthorize'))), 60000);
      const fail = (message: string) => { clearTimeout(timeout); reject(new Error(message)); };
      const client = identity()!.accounts.oauth2.initTokenClient({
        client_id: clientId, scope: DRIVE_SCOPE, include_granted_scopes: false,
        callback: (response) => {
          if (response.error || !response.access_token) return fail(t('drive.authCancelled'));
          if (!response.scope?.split(' ').includes(DRIVE_SCOPE)) return fail(t('drive.scopeRequired'));
          clearTimeout(timeout);
          token = { clientId, value: response.access_token, expiresAt: Date.now() + Number(response.expires_in ?? 3600) * 1000 };
          try { writeWebDriveSession(window.localStorage, token); } catch { /* Session still works in memory. */ }
          resolve(token.value);
        },
        error_callback: () => fail(t('drive.reauthorize')),
      });
      client.requestAccessToken({ prompt: chooseAccount ? 'select_account' : '' });
    });
  } finally { authorizing = false; }
}

export async function disconnectDriveAuth(): Promise<void> {
  token = null;
  try { window.localStorage.removeItem(DRIVE_SESSION_KEY); } catch { /* Storage may be unavailable. */ }
}
export async function invalidateDriveToken(_token: string): Promise<void> { await disconnectDriveAuth(); }
