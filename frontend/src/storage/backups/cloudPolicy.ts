import type { Db } from '../../database/types';

export const CLOUD_SETTINGS = ['language', 'repeatMode', 'historyEnabled'];
export const MAX_CLOUD_BYTES = 64 * 1024 * 1024;

/** Operates only on a snapshot. VACUUM is required before upload to erase deleted paths/cache. */
export async function sanitizeCloudDatabase(db: Db): Promise<void> {
  await db.runAsync('DELETE FROM downloads');
  await db.runAsync('DELETE FROM catalog_cache');
  await db.runAsync(`DELETE FROM settings WHERE key NOT IN (${CLOUD_SETTINGS.map(() => '?').join(',')})`, ...CLOUD_SETTINGS);
  await db.runAsync("UPDATE tracks SET source_id = 'local-unavailable:' || id WHERE source = 'local'");
  await db.runAsync("UPDATE tracks SET artwork_url = '' WHERE artwork_url NOT LIKE 'https://%' AND artwork_url NOT LIKE 'http://%'");
  await db.runAsync("UPDATE playlists SET cover_url = NULL WHERE cover_url NOT LIKE 'https://%' AND cover_url NOT LIKE 'http://%'");
}

export function remoteChanged(remote: { id: string; version: string } | null, checkpoint: string | null): boolean {
  return remote !== null && `${remote.id}:${remote.version}` !== checkpoint;
}
