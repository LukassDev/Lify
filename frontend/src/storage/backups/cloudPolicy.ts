import type { Db } from '../../database/types';

export const CLOUD_SETTINGS = ['language', 'repeatMode', 'historyEnabled'];
export const MAX_CLOUD_BYTES = 64 * 1024 * 1024;

/** Operates only on a snapshot. VACUUM is required before upload to erase deleted paths/cache. */
export async function sanitizeCloudDatabase(db: Db): Promise<void> {
  if (await db.getFirstAsync("SELECT name FROM sqlite_master WHERE name='realtime_control'")) {
    await db.runAsync('UPDATE realtime_control SET enabled=0,applying=1,owner=NULL,cursor=0 WHERE id=1');
    await db.runAsync('DELETE FROM realtime_outbox');
    await db.runAsync('DELETE FROM realtime_documents');
  }
  await db.runAsync('DELETE FROM downloads');
  await db.runAsync('DELETE FROM catalog_cache');
  await db.runAsync(`DELETE FROM settings WHERE key NOT IN (${CLOUD_SETTINGS.map(() => '?').join(',')})`, ...CLOUD_SETTINGS);
  await db.runAsync("UPDATE tracks SET source_id = 'local-unavailable:' || id WHERE source = 'local'");
  await db.runAsync("UPDATE tracks SET artwork_url = '' WHERE artwork_url NOT LIKE 'https://%' AND artwork_url NOT LIKE 'http://%'");
  await db.runAsync("UPDATE playlists SET cover_url = NULL WHERE cover_url NOT LIKE 'https://%' AND cover_url NOT LIKE 'http://%'");
}

export interface RemoteLibrary { id: string; version: string; md5Checksum?: string }

export function cloudFileKey(remote: RemoteLibrary): string {
  return remote.md5Checksum ? `${remote.id}:md5:${remote.md5Checksum}` : `${remote.id}:${remote.version}`;
}

export function remoteChanged(remote: RemoteLibrary | null, checkpoint: string | null): boolean {
  // Accept existing version-only checkpoints while upgrading to content checksums.
  return remote !== null && cloudFileKey(remote) !== checkpoint && `${remote.id}:${remote.version}` !== checkpoint;
}
