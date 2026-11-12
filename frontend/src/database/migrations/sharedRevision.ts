const tables = ['tracks', 'playlists', 'playlist_tracks', 'favorites', 'history'];
const clock = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export const SHARED_REVISION_SQL = `
  CREATE TABLE sync_metadata (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, modified_at INTEGER NOT NULL);
  INSERT INTO sync_metadata VALUES (1, 0, ${clock});
  ${tables.flatMap((table) => ['INSERT', 'UPDATE', 'DELETE'].map((event) => `
    CREATE TRIGGER sync_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
    BEGIN UPDATE sync_metadata SET revision = revision + 1, modified_at = ${clock} WHERE id = 1; END;
  `)).join('\n')}
  ${['INSERT', 'UPDATE', 'DELETE'].map((event) => `
    CREATE TRIGGER sync_settings_${event.toLowerCase()} AFTER ${event} ON settings
    WHEN ${event === 'DELETE' ? 'OLD' : 'NEW'}.key IN ('language', 'repeatMode', 'historyEnabled')
    BEGIN UPDATE sync_metadata SET revision = revision + 1, modified_at = ${clock} WHERE id = 1; END;
  `).join('\n')}
`;
