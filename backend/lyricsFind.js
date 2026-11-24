'use strict';

// Uses the public website flow documented by lleans/lyricfind-scrapper.
const DOMAIN = 'https://lyrics.lyricfind.com/';
const normalize = (text) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\b(?:official\s+(?:music\s+)?(?:video|audio)|lyrics?\s+video)\b/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

function createLyricsFind(fetchPage = fetch) {
  const cache = new Map();
  return async function lookup(title, artist, signal) {
    const key = JSON.stringify([normalize(title), normalize(artist)]);
    const cached = cache.get(key);
    if (cached?.expires > Date.now()) return cached.value;
    const get = async (url, headers = {}) => {
      const response = await fetchPage(url, { signal, redirect: 'error', headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: DOMAIN, ...headers,
      } });
      if (!response.ok) throw new Error(`LyricFind HTTP ${response.status}`);
      return response;
    };
    const home = await get(DOMAIN);
    const token = home.headers.get('set-cookie')?.match(/(?:^|[,;]\s*)token=([^;]+)/)?.[1];
    // Consume the body so the connection can be reused.
    await home.text();
    const params = new URLSearchParams({ reqtype: 'default', territory: 'pt', output: 'json',
      searchtype: 'track', limit: '5', all: `${normalize(title)} ${normalize(artist)}`, alltracks: 'no', useragent: 'Mozilla/5.0' });
    const search = await get(`${DOMAIN}api/v1/search?${params}`, token ? { Authorization: `Bearer ${token}` } : {});
    const data = await search.json();
    if (!Array.isArray(data.tracks) && data.response?.code !== 404) throw new Error('Invalid LyricFind search response');
    const tracks = [];
    for (const item of (data.tracks ?? []).slice(0, 5)) {
      const name = item.artist?.name ?? item.artists?.[0]?.name;
      if (typeof item.title !== 'string' || typeof name !== 'string' || item.instrumental
        || normalize(item.title) !== normalize(title) || normalize(name) !== normalize(artist)
        || typeof item.slug !== 'string' || !/^[\p{L}\p{N}_-]+$/u.test(item.slug)) continue;
      const page = await (await get(`${DOMAIN}lyrics/${encodeURIComponent(item.slug)}`)).text();
      const json = page.match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i)?.[1];
      if (!json) throw new Error('LyricFind page format changed');
      const track = JSON.parse(json).props?.pageProps?.songData?.track;
      const pageArtist = track?.artist?.name ?? track?.artists?.[0]?.name;
      if (typeof track?.title !== 'string' || typeof pageArtist !== 'string'
        || normalize(track.title) !== normalize(title) || normalize(pageArtist) !== normalize(artist)
        || track.instrumental || typeof track.lyrics !== 'string' || !track.lyrics.trim()) continue;
      tracks.push({ title: track.title, artist: pageArtist, lyrics: track.lyrics, instrumental: false });
      break;
    }
    signal.throwIfAborted();
    const value = { tracks };
    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + (tracks.length ? 3600000 : 300000) });
    return value;
  };
}

module.exports = { createLyricsFind };
