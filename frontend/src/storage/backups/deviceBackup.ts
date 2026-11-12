import * as SQLite from 'expo-sqlite';
import { getDb } from '@/database/client';
import { getDeviceDb } from '@/database/device';
import type { Db } from '@/database/types';
import { throwIfBackupCancelled } from './cancellation';

export async function cloneSharedDatabase(): Promise<SQLite.SQLiteDatabase> {
  const copy = await SQLite.openDatabaseAsync(':memory:', { useNewConnection: true });
  try {
    await SQLite.backupDatabaseAsync({ sourceDatabase: await getDb(), destDatabase: copy });
    await copy.execAsync('PRAGMA journal_mode = DELETE');
    return copy;
  } catch (error) {
    await copy.closeAsync();
    throw error;
  }
}

/** Legacy portable backups may still carry audio; only their temporary DB has paths. */
export async function portableDownloadRows(): Promise<{ track_id: string; local_path: string; downloaded_at: number }[]> {
  const ids = new Set((await (await getDb()).getAllAsync<{ id: string }>('SELECT id FROM tracks')).map((row) => row.id));
  return (await (await getDeviceDb()).getAllAsync<{ track_id: string; local_path: string; downloaded_at: number }>('SELECT * FROM downloads')).filter((row) => ids.has(row.track_id));
}

export async function serializePortableDatabase(includeDownloads = true, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfBackupCancelled(signal);
  const copy = await cloneSharedDatabase();
  try {
    throwIfBackupCancelled(signal);
    const rows = includeDownloads ? await portableDownloadRows() : [];
    for (const row of rows) {
      throwIfBackupCancelled(signal);
      await copy.runAsync('INSERT OR REPLACE INTO downloads SELECT id, ?, ? FROM tracks WHERE id = ?', row.local_path, row.downloaded_at, row.track_id);
    }
    throwIfBackupCancelled(signal);
    const bytes = await copy.serializeAsync();
    throwIfBackupCancelled(signal);
    return bytes;
  } finally { await copy.closeAsync(); }
}

export async function restoreDeviceDownloads(incoming: Db, replaceShared: () => Promise<void>): Promise<void> {
  const rows = await incoming.getAllAsync<{ track_id: string; local_path: string; downloaded_at: number }>('SELECT * FROM downloads');
  const device = await getDeviceDb();
  await device.withTransactionAsync(async () => {
    for (const row of rows) {
      await device.runAsync('INSERT OR REPLACE INTO downloads VALUES (?, ?, ?)', row.track_id, row.local_path, row.downloaded_at);
    }
    await incoming.runAsync('DELETE FROM downloads');
    await replaceShared();
  });
}
