import { getDb, settingsRepo } from '@/database';
import { getStreamServerUrl } from './catalog/server';
import { lyricsMetadataMatches, type Lyrics, type LyricsQuery } from './lyrics';

export async function fetchLyricsFind(query: LyricsQuery, signal: AbortSignal): Promise<Lyrics | null> {
  const settings = await settingsRepo.loadSettings(await getDb());
  if (signal.aborted) throw new Error('Lyrics request aborted');
  if (!settings.customStreamServerUrl.trim()) return null;
  const params = new URLSearchParams({ title: query.title, artist: query.artist });
  const response = await fetch(`${getStreamServerUrl(settings)}/lyrics/lyricfind?${params}`, { signal });
  if (!response.ok) throw new Error(`LyricFind HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.tracks)) return null;
  for (const track of data.tracks) {
    if (typeof track.title === 'string' && typeof track.artist === 'string'
      && lyricsMetadataMatches(track.title, track.artist, query)
      && typeof track.lyrics === 'string' && track.lyrics.trim() && !track.instrumental) {
      return { kind: 'plain', text: track.lyrics.trim(), source: 'lyricfind' };
    }
  }
  return null;
}
