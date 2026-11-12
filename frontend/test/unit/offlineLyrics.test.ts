import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Db, SqlValue } from '../../src/database/types';
import { DEVICE_SCHEMA } from '../../src/database/deviceSchema';
import { getLyrics, removeLyrics, saveLyrics } from '../../src/database/repositories/lyrics';
import { lyricsQueryKey, type Lyrics } from '../../src/services/lyrics';

function openDb(raw: DatabaseSync): Db {
  raw.exec(DEVICE_SCHEMA);
  return {
    async getFirstAsync<T>(sql: string, ...params: SqlValue[]) {
      return (raw.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async getAllAsync<T>(sql: string, ...params: SqlValue[]) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async runAsync(sql: string, ...params: SqlValue[]) {
      const result = raw.prepare(sql).run(...params);
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) };
    },
    async withTransactionAsync(task: () => Promise<void>) {
      raw.exec('BEGIN');
      try { await task(); raw.exec('COMMIT'); } catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
}

const query = { title: 'Song', artist: 'Band', duration: 210 };

test('downloaded plain and synced lyrics survive reopening the repository without network access', async () => {
  const raw = new DatabaseSync(':memory:');
  let db = openDb(raw);
  const cases: Lyrics[] = [
    { kind: 'plain', text: 'First line\nSecond line' },
    { kind: 'synced', lines: [{ time: 5, text: 'First line' }, { time: 10.25, text: 'Second line' }] },
  ];
  try {
    for (const lyrics of cases) {
      await saveLyrics(db, 'track', { signature: lyricsQueryKey(query), lyrics });
      db = openDb(raw);
      assert.deepEqual((await getLyrics(db, 'track', query))?.lyrics, lyrics);
    }
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM device_state').get()?.count, 1);
  } finally { raw.close(); }
});

test('saved unavailable result can be read offline and rejects changed track metadata', async () => {
  const raw = new DatabaseSync(':memory:');
  const db = openDb(raw);
  try {
    await saveLyrics(db, 'track', { signature: lyricsQueryKey(query), lyrics: null });
    assert.equal((await getLyrics(db, 'track', query))?.lyrics, null);
    assert.ok(await getLyrics(db, 'track', { ...query, title: ' SONG ', duration: 210.1 }));
    for (const changed of [{ ...query, title: 'Song (Live)' }, { ...query, artist: 'Other' }, { ...query, duration: 211 }]) {
      assert.equal(await getLyrics(db, 'track', changed), null);
    }
    assert.equal(await getLyrics(db, 'missing', query), null);
  } finally { raw.close(); }
});

test('cancelling the download transaction rolls back its lyrics too', async () => {
  const raw = new DatabaseSync(':memory:');
  const db = openDb(raw);
  try {
    await assert.rejects(db.withTransactionAsync(async () => {
      await db.runAsync('INSERT INTO downloads VALUES (?, ?, ?)', 'track', 'audio', 100);
      await saveLyrics(db, 'track', { signature: lyricsQueryKey(query), lyrics: { kind: 'plain', text: 'Line' } });
      throw new Error('Cancelled');
    }));
    assert.equal(await getLyrics(db, 'track', query), null);
    assert.equal(await db.getFirstAsync('SELECT * FROM downloads'), null);
  } finally { raw.close(); }
});

test('removing downloaded lyrics preserves other tracks and device settings', async () => {
  const raw = new DatabaseSync(':memory:');
  const db = openDb(raw);
  try {
    const saved = { signature: lyricsQueryKey(query), lyrics: null };
    await saveLyrics(db, 'one', saved);
    await saveLyrics(db, 'two', saved);
    await db.runAsync('INSERT INTO device_state VALUES (?, ?)', 'setting', 'true');
    await removeLyrics(db, 'one');
    assert.equal(await getLyrics(db, 'one', query), null);
    assert.ok(await getLyrics(db, 'two', query));
    assert.ok(await db.getFirstAsync('SELECT value FROM device_state WHERE key = ?', 'setting'));
  } finally { raw.close(); }
});

test('corrupt or malformed stored lyrics are ignored', async () => {
  const raw = new DatabaseSync(':memory:');
  const db = openDb(raw);
  try {
    for (const value of ['invalid JSON', 'null', JSON.stringify({ signature: lyricsQueryKey(query), lyrics: { kind: 'synced', lines: [{ time: -1, text: 'Bad' }] } })]) {
      await db.runAsync('INSERT OR REPLACE INTO device_state VALUES (?, ?)', 'lyrics:track', value);
      assert.equal(await getLyrics(db, 'track', query), null);
    }
  } finally { raw.close(); }
});
