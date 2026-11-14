import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../src/database/migrate';
import { DEVICE_SCHEMA, migrateDeviceData } from '../../src/database/deviceSchema';
import type { Db, SqlValue } from '../../src/database/types';
import { prepareCloudRestore } from '../../src/storage/backups/cloudData';
import { remoteChanged, sanitizeCloudDatabase } from '../../src/storage/backups/cloudPolicy';
import { copyAllData } from '../../src/storage/backups/copyData';
import { saveDownload, getDownload } from '../../src/database/repositories/downloads';

function database() {
  const raw = new DatabaseSync(':memory:');
  const db: Db & { execAsync(sql: string): Promise<void>; isInTransactionSync(): boolean } = {
    async getFirstAsync<T>(sql: string, ...params: SqlValue[]) { return (raw.prepare(sql).get(...params) as T | undefined) ?? null; },
    async getAllAsync<T>(sql: string, ...params: SqlValue[]) { return raw.prepare(sql).all(...params) as T[]; },
    async runAsync(sql: string, ...params: SqlValue[]) {
      const result = raw.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    async execAsync(sql: string) { raw.exec(sql); },
    isInTransactionSync() { return raw.isTransaction; },
    async withTransactionAsync(task) {
      raw.exec('BEGIN');
      try { await task(); raw.exec('COMMIT'); } catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
  return { raw, db };
}

async function track(db: Db, id = 'youtube:one', source = 'youtube', sourceId = 'one') {
  await db.runAsync('INSERT INTO tracks VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)', id, source, sourceId, 'Song', 'Artist', 'https://example.com/cover.jpg');
}

test('legacy downloads migrate once and a retry cannot overwrite newer device paths', async () => {
  const shared = database(), device = database();
  try {
    await runMigrations(shared.db);
    await track(shared.db);
    await saveDownload(shared.db, 'youtube:one', 'file:///old.m4a', 1);
    await migrateDeviceData(shared.db, device.db);
    assert.equal((await getDownload(device.db, 'youtube:one'))?.local_path, 'file:///old.m4a');
    assert.equal(await getDownload(shared.db, 'youtube:one'), null);
    await saveDownload(device.db, 'youtube:one', 'file:///new.m4a', 2);
    // A previous interrupted attempt may have left a stale legacy row.
    await saveDownload(shared.db, 'youtube:one', 'file:///old.m4a', 1);
    await migrateDeviceData(shared.db, device.db);
    assert.equal((await getDownload(device.db, 'youtube:one'))?.local_path, 'file:///new.m4a');
    assert.equal(await getDownload(shared.db, 'youtube:one'), null);
  } finally { shared.raw.close(); device.raw.close(); }
});

test('cloud snapshots exclude download state, device settings, cache and local media paths', async () => {
  const { db, raw } = database();
  try {
    await runMigrations(db);
    await track(db, 'local:one', 'local', 'file:///private/audio/song.mp3');
    await saveDownload(db, 'local:one', 'file:///private/downloads/song.mp3', 1);
    await db.runAsync("INSERT INTO settings VALUES ('customStreamServerUrl', ?), ('language', ?)", '"https://private.example"', '"en"');
    await db.runAsync("INSERT INTO catalog_cache VALUES ('secret', 'cached paths', 1, 1)");
    await db.runAsync("UPDATE tracks SET artwork_url = 'file:///private/cover.jpg'");
    await sanitizeCloudDatabase(db);
    assert.deepEqual(await db.getAllAsync('SELECT * FROM downloads'), []);
    assert.deepEqual(await db.getAllAsync('SELECT * FROM catalog_cache'), []);
    assert.deepEqual((await db.getAllAsync<{ key: string }>('SELECT key FROM settings')).map((r) => r.key), ['language']);
    assert.equal((await db.getFirstAsync<{ source_id: string }>('SELECT source_id FROM tracks'))?.source_id, 'local-unavailable:local:one');
    assert.equal((await db.getFirstAsync<{ artwork_url: string }>('SELECT artwork_url FROM tracks'))?.artwork_url, '');
  } finally { raw.close(); }
});

test('one shared library restores to two devices with independent downloads and settings', async () => {
  const cloud = database(), mobile = database(), web = database(), mobileDevice = database(), webDevice = database();
  const all = [cloud, mobile, web, mobileDevice, webDevice];
  try {
    for (const shared of [cloud, mobile, web]) await runMigrations(shared.db);
    for (const local of [mobileDevice, webDevice]) await local.db.execAsync(DEVICE_SCHEMA);
    await track(cloud.db);
    await track(cloud.db, 'local:import', 'local', 'file:///other-device/song.mp3');
    await cloud.db.runAsync("INSERT INTO playlists (id, name, created_at, updated_at, pinned) VALUES (1, 'Cloud playlist', 1, 1, 1)");
    await cloud.db.runAsync("INSERT INTO favorites VALUES ('youtube:one', 1)");
    await cloud.db.runAsync("INSERT INTO settings VALUES ('language', ?), ('customStreamServerUrl', ?)", '"en"', '"https://wrong-device"');
    await track(mobile.db, 'local:import', 'local', 'file:///mobile/audio/song.mp3');
    await mobile.db.runAsync("INSERT INTO settings VALUES ('customStreamServerUrl', ?), ('autoBackupIntervalDays', '7')", '"https://mobile.example"');
    await saveDownload(mobileDevice.db, 'youtube:one', 'file:///mobile/downloads/one.m4a', 1);
    await saveDownload(webDevice.db, 'youtube:two', 'web-download:two', 2);
    await prepareCloudRestore(cloud.db, mobile.db, mobileDevice.db);
    await copyAllData(cloud.db, mobile.db);
    assert.equal((await mobile.db.getFirstAsync<{ source_id: string }>("SELECT source_id FROM tracks WHERE source = 'local'"))?.source_id, 'file:///mobile/audio/song.mp3');
    assert.equal((await mobile.db.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key = 'customStreamServerUrl'"))?.value, '"https://mobile.example"');
    assert.equal((await mobile.db.getFirstAsync<{ pinned: number }>('SELECT pinned FROM playlists'))?.pinned, 1);
    await prepareCloudRestore(cloud.db, web.db, webDevice.db);
    await copyAllData(cloud.db, web.db);
    assert.equal((await web.db.getFirstAsync<{ source_id: string }>("SELECT source_id FROM tracks WHERE source = 'local'"))?.source_id, 'local-unavailable:local:import');
    assert.equal((await getDownload(mobileDevice.db, 'youtube:one'))?.local_path, 'file:///mobile/downloads/one.m4a');
    assert.equal(await getDownload(webDevice.db, 'youtube:one'), null);
    assert.equal((await getDownload(webDevice.db, 'youtube:two'))?.local_path, 'web-download:two');
    assert.equal((await web.db.getAllAsync('SELECT * FROM favorites')).length, 1);
  } finally { all.forEach(({ raw }) => raw.close()); }
});

test('library revisions track shared edits but exclude backup timestamps and downloads', async () => {
  const { db, raw } = database();
  try {
    await runMigrations(db);
    const revision = async () => (await db.getFirstAsync<{ revision: number }>('SELECT revision FROM sync_metadata'))!.revision;
    const initial = await revision();
    await track(db);
    assert.ok(await revision() > initial);
    const before = await revision();
    await db.runAsync("UPDATE tracks SET title = title, artist = artist");
    assert.equal(await revision(), before, 're-saving unchanged track metadata does not dirty the library');
    await db.runAsync("INSERT INTO settings VALUES ('language', '\"pt\"')");
    const afterLanguage = await revision();
    await db.runAsync("UPDATE settings SET value = value WHERE key = 'language'");
    assert.equal(await revision(), afterLanguage, 're-saving unchanged settings does not dirty the library');
    await db.runAsync("DELETE FROM settings WHERE key = 'language'");
    const afterSettings = await revision();
    await db.runAsync("INSERT INTO settings VALUES ('lastAutoBackupAt', '123')");
    await saveDownload(db, 'youtube:one', 'file:///one', 1);
    assert.equal(await revision(), afterSettings);
    await db.runAsync("INSERT INTO favorites VALUES ('youtube:one', 123)");
    assert.ok(await revision() > before);
  } finally { raw.close(); }
});

test('failed restore rolls back shared data and revision guard runs before deletion', async () => {
  const source = database(), target = database();
  try {
    await runMigrations(source.db); await runMigrations(target.db);
    await track(target.db);
    await assert.rejects(copyAllData(source.db, target.db, async () => { throw new Error('local changed'); }), /local changed/);
    assert.equal((await target.db.getAllAsync('SELECT * FROM tracks')).length, 1);
  } finally { source.raw.close(); target.raw.close(); }
});

test('unseen remote versions always require conflict resolution, including first connection', () => {
  assert.equal(remoteChanged(null, null), false);
  assert.equal(remoteChanged({ id: 'a', version: '2' }, null), true);
  assert.equal(remoteChanged({ id: 'a', version: '2' }, 'a:2'), false);
  assert.equal(remoteChanged({ id: 'a', version: '3' }, 'a:2'), true);
  assert.equal(remoteChanged({ id: 'b', version: '2' }, 'a:2'), true);
});
