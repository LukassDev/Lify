import type { Db } from './types';
import type { MigrationDb } from './migrate';

export const DEVICE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS downloads (
    track_id TEXT PRIMARY KEY NOT NULL,
    local_path TEXT NOT NULL,
    downloaded_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS local_audio (
    track_id TEXT PRIMARY KEY NOT NULL,
    local_path TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS device_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
`;

/** Copy first, clear second: a crash can repeat this safely without losing paths. */
export async function migrateDeviceData(shared: Db, device: Db & Pick<MigrationDb, 'execAsync'>): Promise<void> {
  await device.execAsync(DEVICE_SCHEMA);
  const downloads = await shared.getAllAsync<{ track_id: string; local_path: string; downloaded_at: number }>(
    'SELECT track_id, local_path, downloaded_at FROM downloads',
  );
  await device.withTransactionAsync(async () => {
    for (const row of downloads) {
      await device.runAsync('INSERT OR IGNORE INTO downloads VALUES (?, ?, ?)', row.track_id, row.local_path, row.downloaded_at);
    }
  });
  await shared.runAsync('DELETE FROM downloads');
}
