// Re-saving identical metadata is common during startup and playback. It must
// not make an otherwise synchronized device appear to have conflicting edits.
const columns: Record<string, string[]> = {
  tracks: ['id', 'source', 'source_id', 'title', 'artist', 'album', 'duration_sec', 'artwork_url'],
  playlists: ['id', 'name', 'description', 'created_at', 'updated_at', 'cover_url', 'pinned'],
  playlist_tracks: ['id', 'playlist_id', 'track_id', 'position', 'added_at'],
  favorites: ['track_id', 'added_at'],
  history: ['id', 'track_id', 'played_at'],
};
const updateRevision = "UPDATE sync_metadata SET revision = revision + 1, modified_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = 1;";
export const MEANINGFUL_REVISION_SQL = `
  ${Object.entries(columns).map(([table, names]) => `
    DROP TRIGGER sync_${table}_update;
    CREATE TRIGGER sync_${table}_update AFTER UPDATE ON ${table}
    WHEN ${names.map((name) => `OLD.${name} IS NOT NEW.${name}`).join(' OR ')}
    BEGIN ${updateRevision} END;
  `).join('\n')}
  DROP TRIGGER sync_settings_update;
  CREATE TRIGGER sync_settings_update AFTER UPDATE ON settings
  WHEN NEW.key IN ('language', 'repeatMode', 'historyEnabled') AND (OLD.key IS NOT NEW.key OR OLD.value IS NOT NEW.value)
  BEGIN ${updateRevision} END;
`;
