import type { Db } from '../../database/types';
import { CLOUD_SETTINGS, sanitizeCloudDatabase } from './cloudPolicy';

/** Prepare an incoming library using this device's paths and scheduling/server preferences. */
export async function prepareCloudRestore(incoming: Db, shared: Db, device: Db): Promise<void> {
  await sanitizeCloudDatabase(incoming);
  for (const row of await shared.getAllAsync<{ id: string; source_id: string }>("SELECT id, source_id FROM tracks WHERE source = 'local' AND source_id NOT LIKE 'local-unavailable:%'")) {
    await device.runAsync('INSERT OR REPLACE INTO local_audio VALUES (?, ?)', row.id, row.source_id);
  }
  for (const row of await device.getAllAsync<{ track_id: string; local_path: string }>('SELECT * FROM local_audio')) {
    await incoming.runAsync("UPDATE tracks SET source_id = ? WHERE id = ? AND source = 'local'", row.local_path, row.track_id);
  }
  for (const row of await shared.getAllAsync<{ key: string; value: string }>('SELECT * FROM settings')) {
    if (!CLOUD_SETTINGS.includes(row.key)) await incoming.runAsync('INSERT OR REPLACE INTO settings VALUES (?, ?)', row.key, row.value);
  }
}
