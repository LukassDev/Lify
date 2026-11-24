import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeLyricsLine, fetchLyrics, matchingLyrics, parseLrc } from '../../src/services/lyrics';

const query = { title: 'Example Song', artist: 'Example Band', duration: 180 };
const record = { trackName: query.title, artistName: query.artist, duration: 180, instrumental: false, plainLyrics: 'First line\nSecond line', syncedLyrics: null };

test('exact metadata returns plain lyrics and preserves line breaks', () => {
  assert.deepEqual(matchingLyrics(record, query), { kind: 'plain', text: record.plainLyrics });
  assert.ok(matchingLyrics({ ...record, trackName: '  EXAMPLE   Song ' }, query));
  assert.ok(matchingLyrics({ ...record, duration: 180.3 }, query));
});

test('rejects different recordings, artists and durations outside tolerance', () => {
  for (const change of [
    { trackName: 'Example Song (Live)' }, { artistName: 'Another Band' },
    { artistName: 'Example Band, Another Band' }, { duration: 186 },
    { duration: 174 }, { duration: NaN }, { duration: '180' },
  ]) assert.equal(matchingLyrics({ ...record, ...change }, query), null);
});

test('instrumentals, missing lyrics and invalid responses are unavailable', () => {
  assert.equal(matchingLyrics({ ...record, instrumental: true }, query), null);
  assert.equal(matchingLyrics({ ...record, plainLyrics: '  ' }, query), null);
  for (const value of [null, undefined, [], {}, 'invalid']) assert.equal(matchingLyrics(value, query), null);
});

test('prefers valid synchronized lyrics and falls back to plain text for invalid LRC', () => {
  assert.deepEqual(matchingLyrics({ ...record, syncedLyrics: '[00:10.50]First line' }, query), {
    kind: 'synced', lines: [{ time: 10.5, text: 'First line' }],
  });
  for (const syncedLyrics of ['[ar:Band]\nnot timed', '[00:10.00]  ', '[00:99.00]Invalid']) {
    assert.equal(matchingLyrics({ ...record, syncedLyrics }, query)?.kind, 'plain');
  }
});

test('LRC supports repeated timestamps, fractions, metadata, offsets and instrumental gaps', () => {
  assert.deepEqual(parseLrc('[ar:Band]\r\n[offset:-500]\n[00:20.125][00:10.5]Repeat\n[00:25]'), [
    { time: 10, text: 'Repeat' }, { time: 19.625, text: 'Repeat' }, { time: 24.5, text: '' },
  ]);
  assert.deepEqual(parseLrc('[offset:100]\n[00:01:25]Line'), [{ time: 1.35, text: 'Line' }]);
});

test('active line follows playback, seeks in either direction, and blank gaps', () => {
  const lines = parseLrc('[00:05]One\n[00:10]Two\n[00:12]\n[00:15]Three');
  assert.equal(activeLyricsLine(lines, 0), -1);
  assert.equal(activeLyricsLine(lines, 5), 0);
  assert.equal(activeLyricsLine(lines, 10), 1);
  assert.equal(activeLyricsLine(lines, 13), 2);
  assert.equal(activeLyricsLine(lines, 100), 3);
  assert.equal(activeLyricsLine(lines, 6), 0);
  assert.equal(activeLyricsLine([], 6), -1);
});

test('search selects a nearby duration and prefers synchronized lyrics', async () => {
  const original = globalThis.fetch;
  const q = { title: 'Nearby Song', artist: 'Band', duration: 260 };
  globalThis.fetch = async (url) => String(url).includes('/search?')
    ? Response.json([
      { ...record, trackName: q.title, artistName: q.artist, duration: 260 },
      { ...record, trackName: q.title, artistName: q.artist, duration: 259, syncedLyrics: '[00:01]Line' },
      { ...record, trackName: q.title, artistName: 'Other', duration: 260 },
    ]) : new Response('', { status: 404 });
  try { assert.equal((await fetchLyrics(q))?.kind, 'synced'); }
  finally { globalThis.fetch = original; }
});

test('fallback works during an outage and cancellation skips fallback', async () => {
  const original = globalThis.fetch;
  let fallbacks = 0;
  const fallback = async () => { fallbacks++; return { kind: 'plain' as const, text: 'Fallback', source: 'lyricfind' as const }; };
  globalThis.fetch = async () => { throw new Error('Network failure'); };
  try {
    assert.equal((await fetchLyrics({ ...query, title: 'Fallback Song' }, undefined, fallback))?.source, 'lyricfind');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(fetchLyrics({ ...query, title: 'Cancelled fallback' }, controller.signal, fallback));
    assert.equal(fallbacks, 1);
  } finally { globalThis.fetch = original; }
});

test('fetch uses the track signature, caches matches, and handles failures without caching them', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    assert.ok(init?.signal);
    assert.ok((init?.headers as Record<string, string>)['Lrclib-Client'].includes('Lify'));
    return new Response(JSON.stringify(record), { status: 200 });
  };
  try {
    assert.equal((await fetchLyrics(query))?.kind, 'plain');
    assert.equal((await fetchLyrics(query))?.kind, 'plain');
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]);
    assert.equal(url.searchParams.get('duration'), '180');
    assert.equal(url.searchParams.get('artist_name'), query.artist);
    assert.equal(url.searchParams.get('track_name'), query.title);
    assert.equal(await fetchLyrics({ ...query, duration: 0 }), null);
    assert.equal(await fetchLyrics({ ...query, artist: '' }), null);
    assert.equal(calls.length, 1);

    const missing = { ...query, title: 'Missing' };
    globalThis.fetch = async (input) => String(input).includes('/search?') ? new Response('[]') : new Response('', { status: 404 });
    assert.equal(await fetchLyrics(missing), null);
    globalThis.fetch = async () => { throw new Error('Should use cached missing result'); };
    assert.equal(await fetchLyrics(missing), null);

    const failing = { ...query, title: 'Network failure' };
    await assert.rejects(fetchLyrics(failing));
    globalThis.fetch = async () => new Response(JSON.stringify({ ...record, trackName: failing.title }));
    assert.equal((await fetchLyrics(failing))?.kind, 'plain');

    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.signal?.aborted, true);
      throw new Error('Aborted');
    };
    await assert.rejects(fetchLyrics({ ...query, title: 'Aborted request' }, controller.signal));

    let throttledCalls = 0;
    globalThis.fetch = async () => {
      throttledCalls++;
      return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
    };
    await assert.rejects(fetchLyrics({ ...query, title: 'Throttled' }));
    await assert.rejects(fetchLyrics({ ...query, title: 'Throttled again' }));
    assert.equal(throttledCalls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

 test('accepts duration tolerance and presentation differences', () => {
   for (const duration of [175, 179, 181, 185]) assert.ok(matchingLyrics({ ...record, duration }, query));
   assert.ok(matchingLyrics({ ...record, trackName: 'Example Song (Official Video)' }, query));
   assert.ok(matchingLyrics({ ...record, artistName: 'Éxample Band' }, query));
 });
