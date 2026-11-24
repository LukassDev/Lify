'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLyricsFind } = require('../lyricsFind');
const { createApp } = require('../index');

test('lyrics route validates input, returns results and reports provider errors', async (t) => {
  const app = createApp({ lyricsFind: async (title, artist, signal) => {
    assert.ok(signal);
    if (title === 'Broken') throw new Error('Blocked');
    return { tracks: [{ title, artist, lyrics: 'Line' }] };
  } });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/lyrics/lyricfind`;
  assert.equal((await fetch(`${base}?title=Song`)).status, 400);
  const response = await fetch(`${base}?title=Song&artist=Band`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).tracks[0].lyrics, 'Line');
  assert.equal((await fetch(`${base}?title=Broken&artist=Band`)).status, 502);
});

test('LyricFind validates metadata, extracts page lyrics and caches the result', async () => {
  const calls = [];
  const track = { title: 'Song', artist: { name: 'Band' }, slug: 'band-song', lyrics: 'Line one\nLine two' };
  const lookup = createLyricsFind(async (url, options) => {
    calls.push(String(url));
    assert.ok(options.signal);
    if (String(url).includes('/api/')) return Response.json({ tracks: [
      { ...track, title: 'Wrong song', slug: 'wrong' }, track,
    ] });
    if (String(url).includes('/lyrics/')) return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { songData: { track } } } })}</script>`);
    return new Response('', { headers: { 'set-cookie': 'token=test-token; Path=/' } });
  });
  const signal = new AbortController().signal;
  assert.deepEqual((await lookup('Song', 'Band', signal)).tracks, [
    { title: 'Song', artist: 'Band', lyrics: track.lyrics, instrumental: false },
  ]);
  await lookup('Song', 'Band', signal);
  assert.equal(calls.length, 3);
  assert.ok(calls[2].endsWith('/lyrics/band-song'));
});

test('provider blocking is an error and is never cached as missing lyrics', async () => {
  let calls = 0;
  const lookup = createLyricsFind(async () => { calls++; return new Response('', { status: 403 }); });
  const signal = new AbortController().signal;
  await assert.rejects(lookup('Song', 'Band', signal), /403/);
  await assert.rejects(lookup('Song', 'Band', signal), /403/);
  assert.equal(calls, 2);
});

test('instrumentals and unrelated search results never fetch a lyrics page', async () => {
  const calls = [];
  const lookup = createLyricsFind(async (url) => {
    calls.push(String(url));
    return String(url).includes('/api/') ? Response.json({ tracks: [
      { title: 'Song (Live)', artist: { name: 'Band' }, slug: 'live' },
      { title: 'Song', artist: { name: 'Band' }, slug: 'instrumental', instrumental: true },
    ] }) : new Response('');
  });
  assert.deepEqual(await lookup('Song', 'Band', new AbortController().signal), { tracks: [] });
  assert.equal(calls.length, 2);
});
