import type { SyncDb, RemoteRow } from './repository';

function origin(value: { name?: unknown; description?: unknown; created_at?: unknown }): string | null {
  if (typeof value.name !== 'string' || typeof value.created_at !== 'number' || value.created_at <= 0) return null;
  return JSON.stringify([value.created_at, value.name, value.description ?? null]);
}

/** Match an imported legacy playlist to its existing cloud identity before seeding it. */
export async function alignPlaylistIdentities(db: SyncDb, remote: RemoteRow[]): Promise<void> {
  const candidates = remote.filter((r) => r.kind === 'playlist' && r.payload && /^[a-f0-9]{32}$/.test(r.entity_key));
  const keys = new Set(remote.filter((r) => r.kind === 'playlist').map((r) => r.entity_key));
  const local = await db.getAllAsync<{ id: number; sync_id: string; name: string; description: string | null; created_at: number }>('SELECT id,sync_id,name,description,created_at FROM playlists');
  for (const p of local) {
    if (keys.has(p.sync_id)) continue;
    const matches = candidates.filter((r) => origin(r.payload as object) === origin(p)).sort((a, b) => a.entity_key.localeCompare(b.entity_key));
    const target = matches[0]?.entity_key;
    if (!target || await db.getFirstAsync('SELECT id FROM playlists WHERE sync_id=?', target)) continue;
    await db.withTransactionAsync(async () => {
      await db.runAsync('UPDATE playlists SET sync_id=? WHERE id=?', target, p.id);
      await db.runAsync("DELETE FROM realtime_documents WHERE kind='playlist' AND entity_key=?", p.sync_id);
      await db.runAsync("DELETE FROM realtime_outbox WHERE kind='playlist' AND entity_key=?", p.sync_id);
    });
  }
}

/** Legacy copies share original creation time, name and description. Never merge by name alone. */
export async function repairDuplicatePlaylists(db: SyncDb): Promise<void> {
  if (await db.isInTransactionAsync()) return;
  const playlists = await db.getAllAsync<{ id: number; sync_id: string; name: string; description: string | null; created_at: number }>('SELECT id,sync_id,name,description,created_at FROM playlists ORDER BY sync_id');
  const groups = new Map<string, typeof playlists>();
  for (const p of playlists) {
    const key = origin(p);
    if (key && p.sync_id) groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keep, ...copies] = group;
    await db.withTransactionAsync(async () => {
      await db.runAsync('UPDATE realtime_control SET applying=1 WHERE id=1');
      for (const copy of copies) {
        const tracks = await db.getAllAsync<{ track_id: string; added_at: number }>('SELECT track_id,added_at FROM playlist_tracks WHERE playlist_id=? ORDER BY position,id', copy.id);
        for (const track of tracks) await db.runAsync(`INSERT INTO playlist_tracks(playlist_id,track_id,position,added_at)
          SELECT ?,?,coalesce((SELECT max(position)+1 FROM playlist_tracks WHERE playlist_id=?),0),?
          WHERE NOT EXISTS(SELECT 1 FROM playlist_tracks WHERE playlist_id=? AND track_id=?)`, keep.id, track.track_id, keep.id, track.added_at, keep.id, track.track_id);
        await db.runAsync('UPDATE playlists SET pinned=max(pinned,(SELECT pinned FROM playlists WHERE id=?)),updated_at=max(updated_at,(SELECT updated_at FROM playlists WHERE id=?)) WHERE id=?', copy.id, copy.id, keep.id);
        await db.runAsync('DELETE FROM playlists WHERE id=?', copy.id);
        await db.runAsync("INSERT INTO realtime_outbox VALUES('playlist',?,NULL,lower(hex(randomblob(16)))) ON CONFLICT(kind,entity_key) DO UPDATE SET payload=NULL,op_id=excluded.op_id", copy.sync_id);
      }
      await db.runAsync("INSERT INTO realtime_outbox SELECT kind,entity_key,payload,lower(hex(randomblob(16))) FROM realtime_documents WHERE kind='playlist' AND entity_key=? ON CONFLICT(kind,entity_key) DO UPDATE SET payload=excluded.payload,op_id=excluded.op_id", keep.sync_id);
      await db.runAsync('UPDATE realtime_control SET applying=0 WHERE id=1');
    });
  }
}
