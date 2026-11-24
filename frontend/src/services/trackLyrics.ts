import { fetchLyricsFind } from './lyricsFind';
import { getDeviceDb } from '@/database/device';
import { getDownload } from '@/database/repositories/downloads';
import { getLyrics, saveLyrics, type SavedLyrics } from '@/database/repositories/lyrics';
import type { Track } from '@/types';
import { fetchLyrics, lyricsQueryKey, type LyricsQuery } from './lyrics';

export function trackLyricsQuery(track: Track, duration = track.durationSec ?? 0): LyricsQuery {
  return { title: track.title, artist: track.artist, duration };
}

export async function loadTrackLyrics(track: Track, duration: number, signal?: AbortSignal) {
  const query = trackLyricsQuery(track, duration);
  const db = await getDeviceDb();
  const saved = await getLyrics(db, track.id, query);
  if (saved?.lyrics) return saved.lyrics;
  const lyrics = await fetchLyrics(query, signal, fetchLyricsFind);
  // Also fills missing lyrics for tracks downloaded before lyrics support existed.
  if (!signal?.aborted && await getDownload(db, track.id)) {
    await saveLyrics(db, track.id, { signature: lyricsQueryKey(query), lyrics });
  }
  return lyrics;
}

/** A lyrics outage must not discard a successfully downloaded audio file. */
export async function prepareDownloadedLyrics(track: Track, signal?: AbortSignal): Promise<SavedLyrics | undefined> {
  try {
    const query = trackLyricsQuery(track);
    const saved = await getLyrics(await getDeviceDb(), track.id, query);
    if (saved?.lyrics) return saved;
    const lyrics = await fetchLyrics(query, signal, fetchLyricsFind);
    if (signal?.aborted) return undefined;
    return { signature: lyricsQueryKey(query), lyrics };
  } catch (error) {
    if (!signal?.aborted) console.warn('[lyrics] Could not download lyrics', error);
    return undefined;
  }
}
