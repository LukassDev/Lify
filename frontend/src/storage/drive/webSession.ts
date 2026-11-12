/** These browser-only values are never part of the shared SQLite database or backups. */
export const DRIVE_CLIENT_ID_KEY = 'lify.drive.clientId';
export const DRIVE_SESSION_KEY = 'lify.drive.session';
export interface WebDriveSession { clientId: string; value: string; expiresAt: number }
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function validGoogleClientId(value: string): boolean {
  return /^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(value);
}

export function readWebDriveSession(storage: StorageLike, clientId: string, now = Date.now()): WebDriveSession | null {
  try {
    const session = JSON.parse(storage.getItem(DRIVE_SESSION_KEY) ?? 'null') as WebDriveSession | null;
    if (session?.clientId === clientId && typeof session.value === 'string' && session.value.length > 0
      && Number.isFinite(session.expiresAt) && session.expiresAt > now + 60000) return session;
    storage.removeItem(DRIVE_SESSION_KEY);
  } catch { /* An unavailable or corrupt browser store must not block interactive sign-in. */ }
  return null;
}

export function writeWebDriveSession(storage: StorageLike, session: WebDriveSession): void {
  storage.setItem(DRIVE_SESSION_KEY, JSON.stringify(session));
}
