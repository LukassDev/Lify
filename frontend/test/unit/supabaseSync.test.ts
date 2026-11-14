import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../src/database/migrate';
import { acknowledgeOutbox, applyRemoteRows, replaceLocalReplicaFromCloud, initializeReplica, initializeReplicaFromLocal, readOutbox, type SyncDb, type RemoteRow } from '../../src/storage/supabase/repository';
import { validateSupabaseConfig } from '../../src/storage/supabase/config';
import { repairDuplicatePlaylists } from '../../src/storage/supabase/playlistIdentity';

async function database() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  const db: SyncDb = {
    async getFirstAsync<T>(sql, ...params) { return (raw.prepare(sql).get(...params) as T | undefined) ?? null; },
    async getAllAsync<T>(sql, ...params) { return raw.prepare(sql).all(...params) as T[]; },
    async runAsync(sql, ...params) { const r = raw.prepare(sql).run(...params); return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }; },
    async execAsync(sql) { raw.exec(sql); },
    isInTransactionSync() { return raw.isTransaction; },
    async isInTransactionAsync() { return raw.isTransaction; },
    async withTransactionAsync(action) { raw.exec('BEGIN'); try { await action(); raw.exec('COMMIT'); } catch (e) { raw.exec('ROLLBACK'); throw e; } },
  };
  await runMigrations({ ...db, isInTransactionSync: db.isInTransactionSync });
  return { raw, db };
}
const track = { id: 'yt:one', source: 'youtube', source_id: 'one', title: 'One', artist: 'Artist', album: null, duration_sec: 100, artwork_url: '' };
async function addTrack(db: SyncDb, id = track.id) {
  await db.runAsync('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?)', id, 'youtube', 'one', 'One', 'Artist', null, 100, '');
}
function remote(rows: Awaited<ReturnType<typeof readOutbox>>, start = 1): RemoteRow[] {
  return rows.map((row, i) => ({ kind: row.kind, entity_key: row.entity_key, payload: row.payload === null ? null : JSON.parse(row.payload), version: start + i }));
}

test('favorites queue automatically but playback, history, downloads and local paths do not', async () => {
  const { db, raw } = await database();
  try {
    await initializeReplica(db, 'project|user', []);
    await addTrack(db);
    await db.runAsync("INSERT INTO history(track_id,played_at) VALUES('yt:one',123)");
    await db.runAsync("INSERT INTO settings VALUES('repeatMode','\"all\"')");
    await db.runAsync("INSERT INTO downloads VALUES('yt:one','file:///song.mp3',123)");
    assert.equal((await readOutbox(db)).length, 0);
    await db.runAsync("INSERT INTO favorites VALUES('yt:one',123)");
    const changes = await readOutbox(db);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, 'favorite');
    assert.equal(changes[0].payload?.includes('file:///'), false);
    await db.runAsync('UPDATE tracks SET title=title');
    assert.equal((await readOutbox(db))[0].op_id, changes[0].op_id);
  } finally { raw.close(); }
});

test('offline edits survive restart and an acknowledgement cannot erase a newer edit', async () => {
  const { db, raw } = await database();
  try {
    await initializeReplica(db, 'project|user', []); await addTrack(db);
    await db.runAsync("INSERT INTO favorites VALUES('yt:one',1)");
    const old = await readOutbox(db);
    await db.runAsync("DELETE FROM favorites WHERE track_id='yt:one'");
    const deletion = await readOutbox(db);
    assert.equal(deletion[0].payload, null);
    await runMigrations(db);
    await acknowledgeOutbox(db, old);
    assert.equal((await readOutbox(db))[0].op_id, deletion[0].op_id);
  } finally { raw.close(); }
});

test('two devices with colliding numeric playlist IDs keep distinct playlists and sync without echo', async () => {
  const a = await database(), b = await database();
  try {
    for (const d of [a, b]) { await initializeReplica(d.db, 'owner', []); await addTrack(d.db); }
    await a.db.runAsync("INSERT INTO playlists(name,created_at,updated_at) VALUES('A',1,1)");
    await a.db.runAsync("INSERT INTO playlist_tracks(playlist_id,track_id,position,added_at) VALUES(1,'yt:one',0,1)");
    await b.db.runAsync("INSERT INTO playlists(name,created_at,updated_at) VALUES('B',1,1)");
    const aChanges = await readOutbox(a.db), bChanges = await readOutbox(b.db);
    assert.notEqual(aChanges[0].entity_key, bChanges[0].entity_key);
    await applyRemoteRows(b.db, remote(aChanges));
    assert.equal((await b.db.getAllAsync('SELECT * FROM playlists')).length, 2);
    assert.equal((await readOutbox(b.db)).length, 1, 'remote changes do not queue another upload');
    assert.equal((await b.db.getAllAsync('SELECT * FROM playlist_tracks')).length, 1);
    await b.db.runAsync('UPDATE tracks SET title=title');
    assert.equal((await readOutbox(b.db)).length, 1, 'JSON key order does not create false edits');
  } finally { a.raw.close(); b.raw.close(); }
});

test('remote edits preserve pending local changes and deleting a playlist sends a tombstone', async () => {
  const { db, raw } = await database();
  try {
    await initializeReplica(db, 'owner', []); await addTrack(db);
    await db.runAsync("INSERT INTO favorites VALUES('yt:one',1)");
    await applyRemoteRows(db, [{ kind: 'favorite', entity_key: track.id, payload: null, version: 2 }]);
    assert.equal((await db.getAllAsync('SELECT * FROM favorites')).length, 1);
    await db.runAsync("INSERT INTO playlists(name,created_at,updated_at) VALUES('A',1,1)");
    const id = (await db.getFirstAsync<{ sync_id: string }>('SELECT sync_id FROM playlists'))!.sync_id;
    await db.runAsync("INSERT INTO playlist_tracks(playlist_id,track_id,position,added_at) VALUES(1,'yt:one',0,1)");
    await db.runAsync('DELETE FROM playlists WHERE id=1');
    assert.equal((await readOutbox(db)).find((r) => r.entity_key === id)?.payload, null);
  } finally { raw.close(); }
});

test('first pairing merges new local documents and changing users does not reuse old pending operations', async () => {
  const { db, raw } = await database();
  try {
    await addTrack(db); await addTrack(db, 'yt:two');
    await db.runAsync("INSERT INTO favorites VALUES('yt:one',1),('yt:two',1)");
    await initializeReplica(db, 'a', [{ kind: 'favorite', entity_key: 'yt:one', payload: null, version: 1 }]);
    const first = await readOutbox(db);
    assert.deepEqual(first.map((r) => r.entity_key), ['yt:two']);
    await initializeReplica(db, 'b', []);
    assert.equal((await readOutbox(db)).length, 2);
    assert.ok((await readOutbox(db)).every((r) => r.op_id !== first[0].op_id));
  } finally { raw.close(); }
});

test('a malformed remote document rolls back the batch and remote preferences never change playback', async () => {
  const { db, raw } = await database();
  try {
    await initializeReplica(db, 'owner', []);
    await assert.rejects(applyRemoteRows(db, [
      { kind: 'favorite', entity_key: track.id, payload: { track, added_at: 1 }, version: 1 },
      { kind: 'preference', entity_key: 'repeatMode', payload: { value: '"all"' }, version: 2 },
    ]));
    assert.equal((await db.getAllAsync('SELECT * FROM favorites')).length, 0);
    assert.equal((await db.getFirstAsync<{ applying: number }>('SELECT applying FROM realtime_control'))?.applying, 0);
  } finally { raw.close(); }
});

test('configuration rejects privileged keys and accepts a public project key', () => {
  assert.equal(validateSupabaseConfig('https://example.supabase.co', 'sb_publishable_public_test_key').url, 'https://example.supabase.co');
  assert.throws(() => validateSupabaseConfig('https://example.supabase.co', 'sb_secret_never_in_frontend'));
  const jwt = 'header.' + btoa(JSON.stringify({ role: 'service_role' })) + '.signature';
  assert.throws(() => validateSupabaseConfig('https://example.supabase.co', jwt));
  assert.throws(() => validateSupabaseConfig('http://example.supabase.co', 'sb_publishable_public_test_key'));
});

test('pairing an imported copy reuses the existing cloud playlist identity', async () => {
  const a = await database(), b = await database();
  try {
    for (const d of [a,b]) {
      await addTrack(d.db);
      await d.db.runAsync("INSERT INTO playlists(name,created_at,updated_at) VALUES('Imported',123456,123456)");
      await d.db.runAsync("INSERT INTO playlist_tracks(playlist_id,track_id,position,added_at) VALUES(1,'yt:one',0,1)");
    }
    await initializeReplica(a.db, 'owner', []);
    const cloud = remote(await readOutbox(a.db));
    await initializeReplica(b.db, 'owner', cloud);
    await applyRemoteRows(b.db, cloud);
    assert.equal((await b.db.getAllAsync('SELECT * FROM playlists')).length, 1);
    assert.equal((await b.db.getFirstAsync<{ sync_id: string }>('SELECT sync_id FROM playlists'))!.sync_id, cloud[0].entity_key);
    await b.db.runAsync("UPDATE playlists SET name='Renamed' WHERE id=1");
    assert.equal((await readOutbox(b.db)).filter((row) => row.kind === 'playlist').length, 1);
  } finally { a.raw.close(); b.raw.close(); }
});

test('repair combines legacy copies without losing songs or downloads and never merges by name alone', async () => {
  const { db, raw } = await database();
  try {
    await initializeReplica(db, 'owner', []);
    await addTrack(db); await addTrack(db, 'yt:two');
    await db.runAsync("INSERT INTO playlists(name,created_at,updated_at) VALUES('Same',123,123),('Same',123,456),('Same',999,999)");
    await db.runAsync("INSERT INTO playlist_tracks(playlist_id,track_id,position,added_at) VALUES(1,'yt:one',0,1),(2,'yt:two',0,1)");
    await db.runAsync("INSERT INTO downloads VALUES('yt:one','file:///one.mp3',1)");
    await repairDuplicatePlaylists(db);
    assert.equal((await db.getAllAsync('SELECT * FROM playlists')).length, 2);
    assert.equal((await db.getAllAsync('SELECT * FROM playlist_tracks')).length, 2);
    assert.equal((await db.getAllAsync('SELECT * FROM downloads')).length, 1);
    assert.equal((await readOutbox(db)).filter((row) => row.kind === 'playlist' && row.payload === null).length, 1);
    await repairDuplicatePlaylists(db);
    assert.equal((await db.getAllAsync('SELECT * FROM playlists')).length, 2);
  } finally { raw.close(); }
});

test('Supabase sync uses asynchronous SQLite access without requiring browser SharedArrayBuffer', async () => {
  const { db, raw } = await database();
  try {
    db.isInTransactionSync = () => { throw new ReferenceError('SharedArrayBuffer is not defined'); };
    await initializeReplica(db, 'owner', []);
    assert.equal((await readOutbox(db)).length, 0);
    await applyRemoteRows(db, [{ kind: 'favorite', entity_key: track.id, payload: { track, added_at: 1 }, version: 1 }]);
    assert.equal((await db.getAllAsync('SELECT * FROM favorites')).length, 1);
    await initializeReplicaFromLocal(db, 'owner', []);
    assert.equal((await readOutbox(db)).length, 1);
  } finally { raw.close(); }
});

test('reconnection after local fallback discards unsent local edits and replaces the library from Supabase', async () => {
  const { db, raw } = await database();
  try {
    await initializeReplica(db, 'owner', []); await addTrack(db);
    await db.runAsync("INSERT INTO favorites VALUES('yt:one',1)");
    await db.runAsync("INSERT INTO playlists(name,created_at,updated_at) VALUES('Offline',1,1)");
    await db.runAsync("INSERT INTO downloads VALUES('yt:one','file:///local.mp3',1)");
    const cloudTrack = { ...track, id: 'yt:cloud' };
    await replaceLocalReplicaFromCloud(db, [{ kind: 'favorite', entity_key: 'yt:cloud', payload: { track: cloudTrack, added_at: 2 }, version: 10 }]);
    assert.deepEqual((await db.getAllAsync<{ track_id: string }>('SELECT track_id FROM favorites')).map((row) => row.track_id), ['yt:cloud']);
    assert.equal((await db.getAllAsync('SELECT * FROM playlists')).length, 0);
    assert.equal((await readOutbox(db)).length, 0);
    assert.equal((await db.getAllAsync('SELECT * FROM downloads')).length, 1);
  } finally { raw.close(); }
});

test('invalid cloud recovery rolls back the replacement and preserves the last local library', async () => {
  const { db, raw } = await database();
  try {
    await initializeReplica(db, 'owner', []); await addTrack(db);
    await db.runAsync("INSERT INTO favorites VALUES('yt:one',1)");
    await assert.rejects(replaceLocalReplicaFromCloud(db, [{ kind: 'invalid', entity_key: 'x', payload: null, version: 10 }]));
    assert.equal((await db.getAllAsync('SELECT * FROM favorites')).length, 1);
    assert.equal((await readOutbox(db)).length, 1);
  } finally { raw.close(); }
});

test('switching from Drive initializes Supabase from the current library, including replacing old cloud data', async () => {
  const { db, raw } = await database();
  try {
    await addTrack(db);
    await db.runAsync("INSERT INTO favorites VALUES('yt:one',123)");
    const cloud: RemoteRow[] = [
      { kind: 'favorite', entity_key: 'yt:one', payload: { track, added_at: 1 }, version: 1 },
      { kind: 'favorite', entity_key: 'yt:old', payload: { track: { ...track, id: 'yt:old' }, added_at: 1 }, version: 2 },
    ];
    await initializeReplicaFromLocal(db, 'new-owner', cloud);
    const pending = await readOutbox(db);
    assert.equal(JSON.parse(pending.find((row) => row.entity_key === 'yt:one')!.payload!).added_at, 123);
    assert.equal(pending.find((row) => row.entity_key === 'yt:old')!.payload, null);
    await applyRemoteRows(db, cloud);
    assert.equal((await db.getFirstAsync<{ added_at: number }>("SELECT added_at FROM favorites WHERE track_id='yt:one'"))!.added_at, 123);
    assert.equal((await db.getAllAsync('SELECT * FROM favorites')).length, 1);
  } finally { raw.close(); }
});
