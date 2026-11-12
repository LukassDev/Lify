import { Image } from 'expo-image';
import { highResolutionImageUrl } from '@/utils/track';

const successfulSources = new Map<string, string>();
const warmed = new Set<string>();
const pending = new Set<string>();
const jobs: { key: string; url: string }[] = [];
let activeJobs = 0;

export function artworkSources(uri?: string | null): string[] {
  const original = uri?.trim();
  if (!original) return [];
  const normalized = highResolutionImageUrl(original);
  const sources = [successfulSources.get(original), normalized, original];
  if (/^https?:\/\/(?:i\d?\.ytimg\.com|img\.youtube\.com)\//i.test(normalized)) {
    for (const quality of ['mqdefault', 'default']) {
      sources.push(normalized.replace(/\/(?:maxresdefault|sddefault|hqdefault|mqdefault|default)(?=\.[a-z]+(?:[?#]|$))/i, `/${quality}`));
    }
  }
  return [...new Set(sources.filter((source): source is string => !!source))];
}

export function rememberArtworkSource(uri: string, source: string): void {
  const key = uri.trim();
  successfulSources.delete(key);
  successfulSources.set(key, source);
  if (successfulSources.size > 500) successfulSources.delete(successfulSources.keys().next().value!);
}

function drainPrefetchQueue(): void {
  while (activeJobs < 3 && jobs.length > 0) {
    const job = jobs.shift()!;
    activeJobs += 1;
    void Image.prefetch(job.url, { cachePolicy: 'memory-disk' }).then((loaded) => {
      if (!loaded) return;
      rememberArtworkSource(job.key, job.url);
      warmed.add(job.url);
      if (warmed.size > 256) warmed.delete(warmed.values().next().value!);
    }).catch(() => {
      // A imagem continua a poder ser carregada pela UI se o prefetch falhar.
    }).finally(() => {
      pending.delete(job.url);
      activeJobs -= 1;
      drainPrefetchQueue();
    });
  }
}

export function prefetchArtwork(uris: readonly (string | null | undefined)[]): void {
  for (const uri of uris.slice(0, 12)) {
    const url = artworkSources(uri)[0];
    if (!uri || !url || !/^https?:\/\//i.test(url) || warmed.has(url) || pending.has(url) || jobs.length >= 48) continue;
    pending.add(url);
    jobs.push({ key: uri, url });
  }
  drainPrefetchQueue();
}

export function prefetchCatalogArtwork(value: unknown): void {
  const uris: string[] = [];
  const collect = (item: unknown): void => {
    if (!item || uris.length >= 12) return;
    if (Array.isArray(item)) {
      for (const entry of item) {
        collect(entry);
        if (uris.length >= 12) break;
      }
      return;
    }
    if (typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const uri = record.artworkUrl ?? record.imageUrl ?? record.coverUrl;
    if (typeof uri === 'string' && uri) uris.push(uri);
    for (const key of ['tracks', 'albums', 'singles', 'eps', 'playlists', 'relatedArtists']) collect(record[key]);
  };
  collect(value);
  prefetchArtwork(uris);
}
