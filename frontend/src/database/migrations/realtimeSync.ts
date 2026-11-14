// A playlist is one document (including ordering); favorites are independent documents.
// This avoids collisions between auto-increment IDs on different devices.
const track = (alias: string) => `json_object('id',${alias}.id,'source',${alias}.source,'source_id',CASE WHEN ${alias}.source='local' THEN 'local-unavailable:'||${alias}.id ELSE ${alias}.source_id END,'title',${alias}.title,'artist',${alias}.artist,'album',${alias}.album,'duration_sec',${alias}.duration_sec,'artwork_url',CASE WHEN ${alias}.artwork_url LIKE 'https://%' OR ${alias}.artwork_url LIKE 'http://%' THEN ${alias}.artwork_url ELSE '' END)`;
const playlistQuery = `SELECT 'playlist',p.sync_id,json_object('name',p.name,'description',p.description,'created_at',p.created_at,'updated_at',p.updated_at,'cover_url',CASE WHEN p.cover_url LIKE 'https://%' OR p.cover_url LIKE 'http://%' THEN p.cover_url ELSE NULL END,'pinned',p.pinned,'tracks',json((SELECT coalesce(json_group_array(json(item)),'[]') FROM (SELECT ${track('t')} AS item FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id WHERE pt.playlist_id=p.id ORDER BY pt.position,pt.id)))) FROM playlists p`;
const favoriteQuery = `SELECT 'favorite',f.track_id,json_object('track',json(${track('t')}),'added_at',f.added_at) FROM favorites f JOIN tracks t ON t.id=f.track_id`;
const settingQuery = `SELECT 'preference',key,json_object('value',value) FROM settings WHERE key IN ('language','historyEnabled')`;
export const DOCUMENT_QUERIES = [playlistQuery, favoriteQuery, settingQuery];
const put = (query: string) => `INSERT INTO realtime_documents(kind,entity_key,payload) SELECT * FROM (${query}) WHERE true ON CONFLICT(kind,entity_key) DO UPDATE SET payload=excluded.payload WHERE payload IS NOT excluded.payload;`;
const tombstone = (kind: string, key: string) => `INSERT INTO realtime_documents VALUES ('${kind}',${key},NULL) ON CONFLICT(kind,entity_key) DO UPDATE SET payload=NULL WHERE payload IS NOT NULL;`;

export const REALTIME_SYNC_SQL = `
 ALTER TABLE playlists ADD COLUMN sync_id TEXT;
 UPDATE playlists SET sync_id=lower(hex(randomblob(16)));
 CREATE UNIQUE INDEX idx_playlist_sync_id ON playlists(sync_id);
 CREATE TABLE realtime_control(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,applying INTEGER NOT NULL DEFAULT 0,owner TEXT,cursor INTEGER NOT NULL DEFAULT 0);
 INSERT INTO realtime_control(id) VALUES (1);
 CREATE TABLE realtime_documents(kind TEXT NOT NULL,entity_key TEXT NOT NULL,payload TEXT,PRIMARY KEY(kind,entity_key));
 CREATE TABLE realtime_outbox(kind TEXT NOT NULL,entity_key TEXT NOT NULL,payload TEXT,op_id TEXT NOT NULL,PRIMARY KEY(kind,entity_key));
 ${DOCUMENT_QUERIES.map(put).join('\n')}
 CREATE TRIGGER realtime_document_insert AFTER INSERT ON realtime_documents WHEN (SELECT enabled=1 AND applying=0 FROM realtime_control WHERE id=1)
 BEGIN INSERT INTO realtime_outbox VALUES(NEW.kind,NEW.entity_key,NEW.payload,lower(hex(randomblob(16)))) ON CONFLICT(kind,entity_key) DO UPDATE SET payload=excluded.payload,op_id=excluded.op_id; END;
 CREATE TRIGGER realtime_document_update AFTER UPDATE ON realtime_documents WHEN OLD.payload IS NOT NEW.payload AND (SELECT enabled=1 AND applying=0 FROM realtime_control WHERE id=1)
 BEGIN INSERT INTO realtime_outbox VALUES(NEW.kind,NEW.entity_key,NEW.payload,lower(hex(randomblob(16)))) ON CONFLICT(kind,entity_key) DO UPDATE SET payload=excluded.payload,op_id=excluded.op_id; END;
 CREATE TRIGGER realtime_playlist_insert AFTER INSERT ON playlists BEGIN
 UPDATE playlists SET sync_id=coalesce(NEW.sync_id,lower(hex(randomblob(16)))) WHERE id=NEW.id;
 ${put(playlistQuery+' WHERE p.id=NEW.id')}
 END;
 CREATE TRIGGER realtime_playlist_update AFTER UPDATE ON playlists WHEN NEW.sync_id IS NOT NULL BEGIN ${put(playlistQuery+' WHERE p.id=NEW.id')} END;
 CREATE TRIGGER realtime_playlist_delete BEFORE DELETE ON playlists BEGIN ${tombstone('playlist','OLD.sync_id')} END;
 ${['INSERT','UPDATE','DELETE'].map((event) => {
   const ref=event==='DELETE'?'OLD':'NEW';
   return `CREATE TRIGGER realtime_membership_${event.toLowerCase()} AFTER ${event} ON playlist_tracks BEGIN ${put(playlistQuery+` WHERE p.id=${ref}.playlist_id`)} END;`;
 }).join('\n')}
 ${['INSERT','UPDATE'].map((event) => `CREATE TRIGGER realtime_favorite_${event.toLowerCase()} AFTER ${event} ON favorites BEGIN ${put(favoriteQuery+' WHERE f.track_id=NEW.track_id')} END;`).join('\n')}
 CREATE TRIGGER realtime_favorite_delete AFTER DELETE ON favorites BEGIN ${tombstone('favorite','OLD.track_id')} END;
 CREATE TRIGGER realtime_track_update AFTER UPDATE ON tracks BEGIN
 ${put(favoriteQuery+' WHERE f.track_id=NEW.id')}
 ${put(playlistQuery+' WHERE EXISTS(SELECT 1 FROM playlist_tracks pt WHERE pt.playlist_id=p.id AND pt.track_id=NEW.id)')}
 END;
 ${['INSERT','UPDATE'].map((event) => `CREATE TRIGGER realtime_setting_${event.toLowerCase()} AFTER ${event} ON settings BEGIN ${put(settingQuery+' AND key=NEW.key')} END;`).join('\n')}
 CREATE TRIGGER realtime_setting_delete AFTER DELETE ON settings WHEN OLD.key IN ('language','historyEnabled') BEGIN ${tombstone('preference','OLD.key')} END;
`;
