export interface LyricsQuery {
  title: string;
  artist: string;
  duration: number;
}

export interface LyricsLine {
  time: number;
  text: string;
}

export type Lyrics = ({ kind: 'synced'; lines: LyricsLine[] } | { kind: 'plain'; text: string }) & { source?: 'lrclib' | 'lyricfind' };

const normalize = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

export const lyricsQueryKey = (query: LyricsQuery): string =>
  JSON.stringify([normalize(query.title), normalize(query.artist), Math.round(query.duration)]);

/** Ignore presentation differences while retaining recording qualifiers (live, remix, etc.). */
export const normalizeLyricsMetadata = (value: string): string => value.normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\b(?:official\s+(?:music\s+)?(?:video|audio)|lyrics?\s+video)\b/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

export function lyricsMetadataMatches(title: string, artist: string, query: LyricsQuery): boolean {
  return normalizeLyricsMetadata(title) === normalizeLyricsMetadata(query.title)
    && normalizeLyricsMetadata(artist) === normalizeLyricsMetadata(query.artist);
}

export function matchingLyrics(record: unknown, query: LyricsQuery): Lyrics | null {
  if (!record || typeof record !== 'object') return null;
  const value = record as Record<string, unknown>;
  if (typeof value.trackName !== 'string' || typeof value.artistName !== 'string'
    || !lyricsMetadataMatches(value.trackName, value.artistName, query)
    || typeof value.duration !== 'number' || !Number.isFinite(value.duration)
    || Math.abs(value.duration - query.duration) > 5
    || value.instrumental === true) return null;

  const lines = typeof value.syncedLyrics === 'string' ? parseLrc(value.syncedLyrics) : [];
  if (lines.some((line) => line.text)) return { kind: 'synced', lines };
  if (typeof value.plainLyrics === 'string' && value.plainLyrics.trim()) {
    return { kind: 'plain', text: value.plainLyrics.trim() };
  }
  return null;
}

export function parseLrc(lrc: string): LyricsLine[] {
  const offset = Number(lrc.match(/\[offset:\s*([+-]?\d+)\]/i)?.[1] ?? 0) / 1000;
  const lines: LyricsLine[] = [];
  for (const row of lrc.split(/\r?\n/)) {
    const stamps = [...row.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = row.replace(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim();
    for (const stamp of stamps) {
      if (Number(stamp[2]) >= 60) continue;
      const time = Number(stamp[1]) * 60 + Number(stamp[2]) + Number(`0.${stamp[3] ?? 0}`) + offset;
      lines.push({ time: Math.max(0, time), text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

export function activeLyricsLine(lines: LyricsLine[], position: number): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (lines[mid].time <= position) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

const cache = new Map<string, { expires: number; lyrics: Lyrics | null }>();
let retryAfter = 0;

export async function fetchLyrics(query: LyricsQuery, signal?: AbortSignal, fallback?: (query: LyricsQuery, signal: AbortSignal) => Promise<Lyrics | null>): Promise<Lyrics | null> {
  if (!normalize(query.title) || !normalize(query.artist) || !Number.isFinite(query.duration)
    || query.duration < 1 || query.duration > 3600) return null;
  const key = lyricsQueryKey(query);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.lyrics;

  const params = new URLSearchParams({
    track_name: query.title.trim(), artist_name: query.artist.trim(), duration: String(Math.round(query.duration)),
  });
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 25000);
  const lrclibController = new AbortController();
  const abortLrclib = () => lrclibController.abort();
  controller.signal.addEventListener('abort', abortLrclib, { once: true });
  if (controller.signal.aborted) abortLrclib();
  const lrclibTimeout = setTimeout(abortLrclib, 10000);
  let failure: unknown;
  try {
    let lyrics: Lyrics | null = null;
    try {
      if (Date.now() < retryAfter) throw new Error('LRCLIB rate limited');
      const response = await fetch(`https://lrclib.net/api/get?${params}`, {
        signal: lrclibController.signal,
        headers: { 'Lrclib-Client': 'Lify v1.2.2 (https://github.com/lukassdev/lify)' },
      });
      if (response.status === 429 || response.status === 503) {
        const wait = response.headers.get('Retry-After');
        const seconds = Number(wait);
        const delay = wait && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(wait ?? '') - Date.now();
        retryAfter = Date.now() + Math.max(1000, Number.isFinite(delay) ? delay : 60000) * (1 + Math.random() * 0.3);
      }
      if (!response.ok && response.status !== 404) throw new Error(`LRCLIB HTTP ${response.status}`);
      lyrics = response.status === 404 ? null : matchingLyrics(await response.json(), query);
      if (!lyrics && response.status !== 429 && response.status !== 503) {
        const search = new URLSearchParams({ track_name: normalizeLyricsMetadata(query.title), artist_name: normalizeLyricsMetadata(query.artist) });
        const results = await fetch(`https://lrclib.net/api/search?${search}`, {
          signal: lrclibController.signal, headers: { 'Lrclib-Client': 'Lify v1.2.2 (https://github.com/lukassdev/lify)' },
        });
        if (!results.ok) throw new Error(`LRCLIB search HTTP ${results.status}`);
        const candidates: unknown = await results.json();
        if (Array.isArray(candidates)) {
          const matches = candidates.filter((item) => matchingLyrics(item, query));
          matches.sort((a, b) => Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics))
            || Math.abs(a.duration - query.duration) - Math.abs(b.duration - query.duration));
          lyrics = matchingLyrics(matches[0], query);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) throw error;
      failure = error;
    } finally {
      clearTimeout(lrclibTimeout);
      controller.signal.removeEventListener('abort', abortLrclib);
    }
    if (!lyrics && fallback) lyrics = await fallback(query, controller.signal);
    if (controller.signal.aborted) throw new Error('Lyrics request aborted');
    if (!lyrics && failure) throw failure;
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + (lyrics ? 3600000 : 300000), lyrics });
    return lyrics;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
