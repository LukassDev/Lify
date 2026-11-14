import type { Db, SqlValue } from '../../database/types';

export interface SyncDb extends Db { execAsync(sql: string): Promise<void>; isInTransactionSync(): boolean }
export interface OutboxRow { kind: string; entity_key: string; payload: string | null; op_id: string }
export interface RemoteRow { kind: string; entity_key: string; payload: unknown; version: number }
const literal = (value: SqlValue) => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`;

export async function initializeReplica(db: SyncDb, owner: string, cloud: RemoteRow[]): Promise<void> {
  if (db.isInTransactionSync()) throw new Error('A biblioteca está a ser atualizada. Tente novamente.');
  const control = await db.getFirstAsync<{ owner: string | null }>('SELECT owner FROM realtime_control WHERE id=1');
  if (control?.owner === owner) return;
  const existing = new Set(cloud.map((row) => row.kind + '\n' + row.entity_key));
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM realtime_outbox');
    const docs = await db.getAllAsync<{ kind: string; entity_key: string; payload: string }>('SELECT * FROM realtime_documents WHERE payload IS NOT NULL');
    for (const doc of docs) {
      if (!existing.has(doc.kind + '\n' + doc.entity_key)) await db.runAsync('INSERT INTO realtime_outbox VALUES(?,?,?,lower(hex(randomblob(16))))', doc.kind, doc.entity_key, doc.payload);
    }
    await db.runAsync('UPDATE realtime_control SET enabled=1,applying=0,owner=?,cursor=0 WHERE id=1', owner);
  });
}

export async function readOutbox(db: SyncDb): Promise<OutboxRow[]> {
  if (db.isInTransactionSync()) return [];
  return db.getAllAsync<OutboxRow>('SELECT * FROM realtime_outbox ORDER BY kind,entity_key LIMIT 100');
}

/** Switching providers deliberately starts the destination from this device's library. */
export async function initializeReplicaFromLocal(db: SyncDb, owner: string, cloud: RemoteRow[]): Promise<void> {
  if (db.isInTransactionSync()) throw new Error('A biblioteca está ocupada. Tente novamente.');
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM realtime_outbox');
    const local = await db.getAllAsync<{ kind: string; entity_key: string; payload: string }>('SELECT * FROM realtime_documents WHERE payload IS NOT NULL');
    const keys = new Set(local.map((row) => row.kind + '\n' + row.entity_key));
    for (const row of local) await db.runAsync('INSERT INTO realtime_outbox VALUES(?,?,?,lower(hex(randomblob(16))))', row.kind, row.entity_key, row.payload);
    for (const row of cloud) {
      if (!keys.has(row.kind + '\n' + row.entity_key)) await db.runAsync('INSERT INTO realtime_outbox VALUES(?,?,NULL,lower(hex(randomblob(16))))', row.kind, row.entity_key);
    }
    await db.runAsync('UPDATE realtime_control SET enabled=1,applying=0,owner=?,cursor=0 WHERE id=1', owner);
  });
}

export async function acknowledgeOutbox(db: SyncDb, rows: OutboxRow[]): Promise<void> {
  for (const row of rows) await db.runAsync('DELETE FROM realtime_outbox WHERE kind=? AND entity_key=? AND op_id=?', row.kind, row.entity_key, row.op_id);
}

/** Offline fallback is explicitly disposable: discard its edits before receiving the server library. */
export async function replaceLocalReplicaFromCloud(db: SyncDb, rows: RemoteRow[]): Promise<void> {
  if (db.isInTransactionSync()) throw new Error('A biblioteca está ocupada.');
  // Validate the full payload before changing the current library.
  await db.execAsync('SAVEPOINT lify_cloud_reset;');
  try {
    await db.execAsync('UPDATE realtime_control SET applying=1 WHERE id=1; DELETE FROM realtime_outbox; DELETE FROM favorites; DELETE FROM playlist_tracks; DELETE FROM playlists; DELETE FROM settings WHERE key IN (\'language\',\'historyEnabled\'); DELETE FROM realtime_documents; UPDATE realtime_control SET cursor=0,applying=0 WHERE id=1;');
    await applyRemoteRows(db, rows, true);
    await db.execAsync('RELEASE lify_cloud_reset;');
  } catch (error) {
    await db.execAsync('ROLLBACK TO lify_cloud_reset; RELEASE lify_cloud_reset;');
    throw error;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Documento Supabase inválido.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 8192): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('Texto inválido no documento Supabase.');
  return value;
}
function num(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Número inválido no documento Supabase.');
  return value;
}
function image(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//.test(value) ? text(value) : null;
}
function trackSql(value: unknown, condition: string): string {
  const t = object(value);
  const id = text(t.id, 512), source = t.source;
  if (source !== 'youtube' && source !== 'local') throw new Error('Fonte de áudio inválida.');
  const sourceId = source === 'local' ? 'local-unavailable:' + id : text(t.source_id, 512);
  const values: SqlValue[] = [id, source, sourceId, text(t.title), text(t.artist), t.album == null ? null : text(t.album), t.duration_sec == null ? null : num(t.duration_sec), image(t.artwork_url) ?? ''];
  return `INSERT INTO tracks(id,source,source_id,title,artist,album,duration_sec,artwork_url) SELECT ${values.map(literal)} WHERE ${condition}
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist=excluded.artist,album=excluded.album,duration_sec=excluded.duration_sec,artwork_url=excluded.artwork_url;
  `;
}

/** One SQL call prevents UI writes from interleaving with the echo-suppression flag. */
export async function applyRemoteRows(db: SyncDb, rows: RemoteRow[], ownSavepoint = false): Promise<void> {
  if (!ownSavepoint && db.isInTransactionSync()) throw new Error('A biblioteca está ocupada; a sincronização vai tentar novamente.');
  let sql = 'SAVEPOINT lify_remote; UPDATE realtime_control SET applying=1 WHERE id=1;';
  let cursor = 0;
  for (const row of rows) {
    const kind = text(row.kind, 32), key = text(row.entity_key, 512);
    if (!['playlist', 'favorite', 'preference'].includes(kind)) throw new Error('Tipo de documento Supabase desconhecido.');
    cursor = Math.max(cursor, num(Number(row.version)));
    const condition = `NOT EXISTS(SELECT 1 FROM realtime_outbox WHERE kind=${literal(kind)} AND entity_key=${literal(key)})`;
    if (kind === 'favorite') {
      if (row.payload === null) sql += `DELETE FROM favorites WHERE track_id=${literal(key)} AND ${condition};`;
      else {
        const p = object(row.payload);
        if (object(p.track).id !== key) throw new Error('Favorito inválido.');
        sql += trackSql(p.track, condition);
        sql += `INSERT INTO favorites SELECT ${literal(key)},${num(p.added_at)} WHERE ${condition} ON CONFLICT(track_id) DO UPDATE SET added_at=excluded.added_at;`;
      }
    } else if (kind === 'playlist') {
      if (!/^[a-f0-9]{32}$/.test(key)) throw new Error('Identificador de playlist inválido.');
      if (row.payload === null) sql += `DELETE FROM playlists WHERE sync_id=${literal(key)} AND ${condition};`;
      else {
        const p = object(row.payload);
        if (!Array.isArray(p.tracks) || p.tracks.length > 10000) throw new Error('Faixas inválidas.');
        const values: SqlValue[] = [text(p.name), p.description == null ? null : text(p.description), num(p.created_at), num(p.updated_at), image(p.cover_url), p.pinned === 1 ? 1 : 0, key];
        sql += `INSERT INTO playlists(name,description,created_at,updated_at,cover_url,pinned,sync_id) SELECT ${values.map(literal)} WHERE ${condition} ON CONFLICT(sync_id) DO UPDATE SET name=excluded.name,description=excluded.description,created_at=excluded.created_at,updated_at=excluded.updated_at,cover_url=excluded.cover_url,pinned=excluded.pinned;`;
        const playlistId = `(SELECT id FROM playlists WHERE sync_id=${literal(key)})`;
        sql += `DELETE FROM playlist_tracks WHERE playlist_id=${playlistId} AND ${condition};`;
        const seen = new Set<string>();
        p.tracks.forEach((track, index) => {
          const id = text(object(track).id, 512);
          if (seen.has(id)) return;
          seen.add(id);
          sql += trackSql(track, condition);
          sql += `INSERT INTO playlist_tracks(playlist_id,track_id,position,added_at) SELECT ${playlistId},${literal(id)},${index},${num(p.updated_at)} WHERE ${condition};`;
        });
      }
    } else {
      if (!['language', 'historyEnabled'].includes(key)) throw new Error('Preferência não sincronizável.');
      if (row.payload === null) sql += `DELETE FROM settings WHERE key=${literal(key)} AND ${condition};`;
      else {
        const value = text(object(row.payload).value, 100);
        const parsed = JSON.parse(value);
        if ((key === 'language' && parsed !== 'pt' && parsed !== 'en') || (key === 'historyEnabled' && typeof parsed !== 'boolean')) throw new Error('Preferência inválida.');
        sql += `INSERT INTO settings SELECT ${literal(key)},${literal(value)} WHERE ${condition} ON CONFLICT(key) DO UPDATE SET value=excluded.value;`;
      }
    }
    // Keep tombstones locally so a later edit/deletion produces the right operation.
    if (row.payload === null) sql += `INSERT INTO realtime_documents SELECT ${literal(kind)},${literal(key)},NULL WHERE ${condition} ON CONFLICT(kind,entity_key) DO UPDATE SET payload=NULL;`;
  }
  sql += `UPDATE realtime_control SET applying=0,cursor=max(cursor,${cursor}) WHERE id=1; RELEASE lify_remote;`;
  try { await db.execAsync(sql); }
  catch (error) {
    await db.execAsync('ROLLBACK TO lify_remote; RELEASE lify_remote;').catch(() => {});
    throw error;
  }
}
