import type { Db } from '../types';
import { lyricsQueryKey, type Lyrics, type LyricsQuery } from '../../services/lyrics';

export interface SavedLyrics {
  signature: string;
  lyrics: Lyrics | null;
}

/** Device state persists across restarts and stays out of cloud library backups. */
export async function saveLyrics(db: Db, trackId: string, value: SavedLyrics): Promise<void> {
  await db.runAsync(
    'INSERT INTO device_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    `lyrics:${trackId}`, JSON.stringify(value),
  );
}

export async function getLyrics(db: Db, trackId: string, query: LyricsQuery): Promise<SavedLyrics | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM device_state WHERE key = ?', `lyrics:${trackId}`);
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as SavedLyrics;
    if (value.signature !== lyricsQueryKey(query)) return null;
    const lyrics = value.lyrics;
    if (lyrics === null) return value;
    if (lyrics?.kind === 'plain' && typeof lyrics.text === 'string' && lyrics.text.trim()) return value;
    if (lyrics?.kind === 'synced' && Array.isArray(lyrics.lines) && lyrics.lines.length
      && lyrics.lines.every((line) => Number.isFinite(line.time) && line.time >= 0 && typeof line.text === 'string')
      && lyrics.lines.every((line, index) => index === 0 || line.time >= lyrics.lines[index - 1].time)) return value;
  } catch { /* Ignore corrupt stored data and allow a fresh lookup. */ }
  return null;
}

export async function removeLyrics(db: Db, trackId: string): Promise<void> {
  await db.runAsync('DELETE FROM device_state WHERE key = ?', `lyrics:${trackId}`);
}
