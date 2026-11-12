import * as SQLite from 'expo-sqlite';
import { DEVICE_SCHEMA } from './deviceSchema';

export const DEVICE_DB_NAME = 'lify-device.db';
let devicePromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** Device-only data is never serialized into a cloud backup. */
export function getDeviceDb(): Promise<SQLite.SQLiteDatabase> {
  if (!devicePromise) {
    devicePromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DEVICE_DB_NAME);
      await db.execAsync(`PRAGMA journal_mode = WAL; ${DEVICE_SCHEMA}`);
      return db;
    })().catch((error: unknown) => { devicePromise = null; throw error; });
  }
  return devicePromise;
}

export async function getDeviceState<T>(key: string, fallback: T): Promise<T> {
  const row = await (await getDeviceDb()).getFirstAsync<{ value: string }>('SELECT value FROM device_state WHERE key = ?', key);
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}

export async function setDeviceState(key: string, value: unknown): Promise<void> {
  await (await getDeviceDb()).runAsync(
    'INSERT INTO device_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, JSON.stringify(value),
  );
}
