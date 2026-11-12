import * as SQLite from 'expo-sqlite';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { getDb, runMigrations } from '@/database/client';
import { getDeviceDb } from '@/database/device';
import { LATEST_VERSION } from '@/database/migrations';
import { cloneSharedDatabase } from './deviceBackup';
import { copyAllData } from './copyData';
import { MAX_CLOUD_BYTES, sanitizeCloudDatabase } from './cloudPolicy';
import { prepareCloudRestore } from './cloudData';
import { t } from '@/i18n';

export async function libraryRevision(): Promise<number> {
  return (await (await getDb()).getFirstAsync<{ revision: number }>('SELECT revision FROM sync_metadata WHERE id = 1'))?.revision ?? 0;
}

export async function createCloudArchive(): Promise<{ bytes: Uint8Array; revision: number }> {
  const snapshot = await cloneSharedDatabase();
  try {
    const revision = (await snapshot.getFirstAsync<{ revision: number }>('SELECT revision FROM sync_metadata WHERE id = 1'))!.revision;
    await sanitizeCloudDatabase(snapshot);
    await snapshot.execAsync('VACUUM');
    const bytes = await snapshot.serializeAsync();
    if (bytes.length > MAX_CLOUD_BYTES) throw new Error(t('backup.tooLarge'));
    // Store uncompressed: bounded size and no decompression bombs on restore.
    return { revision, bytes: zipSync({
      'database.db': bytes,
      'manifest.json': strToU8(JSON.stringify({ format: 'lify-cloud-backup', version: 1, createdAt: Date.now() })),
    }, { level: 0 }) };
  } finally { await snapshot.closeAsync(); }
}

export async function restoreCloudArchive(bytes: Uint8Array, expectedRevision?: number): Promise<void> {
  if (bytes.length > MAX_CLOUD_BYTES + 4096) throw new Error(t('backup.tooLarge'));
  const entries = unzipSync(bytes, { filter: (entry) => {
    if (entry.compression !== 0 || (entry.name !== 'database.db' && entry.name !== 'manifest.json') || entry.originalSize > (entry.name === 'database.db' ? MAX_CLOUD_BYTES : 4096)) {
      throw new Error(t('backup.unreadable'));
    }
    return true;
  } });
  const manifest = JSON.parse(strFromU8(entries['manifest.json'] ?? new Uint8Array()));
  if (manifest.format !== 'lify-cloud-backup' || manifest.version !== 1 || !entries['database.db']) throw new Error(t('backup.unreadable'));
  const incoming = await SQLite.deserializeDatabaseAsync(entries['database.db']);
  try {
    const version = (await incoming.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
    if (version > LATEST_VERSION) throw new Error(t('backup.tooNew'));
    if (version < 1) throw new Error(t('backup.notLify'));
    await runMigrations(incoming);
    const integrity = await incoming.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check');
    if (integrity?.integrity_check !== 'ok') throw new Error(t('backup.unreadable'));
    if ((await incoming.getAllAsync('PRAGMA foreign_key_check')).length) throw new Error(t('backup.unreadable'));
    const db = await getDb();
    const device = await getDeviceDb();
    await prepareCloudRestore(incoming, db, device);
    // Safety copy is also metadata-only and remains on this device.
    const safety = await createCloudArchive();
    await saveCloudSafety(safety.bytes);
    await copyAllData(incoming, db, async () => {
      if (expectedRevision !== undefined && await libraryRevision() !== expectedRevision) throw new Error(t('drive.localChanged'));
    });
  } finally { await incoming.closeAsync(); }
}

// Platform-specific storage avoids sharing/downloading a file during automatic operation.
import { saveCloudSafety } from './cloudSafety';
