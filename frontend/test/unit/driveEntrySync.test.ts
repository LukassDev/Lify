import assert from 'node:assert/strict';
import test from 'node:test';
import { createEntrySync } from '../../src/storage/drive/entrySync';

test('startup runs sync immediately and resume runs again without a schedule interval', async () => {
  let calls = 0;
  const entry = createEntrySync({ ready: () => true, synchronize: async () => { calls++; }, onStart() {}, onError() {} });
  await entry.drain();
  assert.equal(calls, 1);
  await entry.drain();
  assert.equal(calls, 1);
  entry.request();
  await Promise.resolve();
  assert.equal(calls, 2);
});

test('disabled or busy Drive defers startup until enabled and idle', async () => {
  let ready = false, calls = 0;
  const entry = createEntrySync({ ready: () => ready, synchronize: async () => { calls++; }, onStart() {}, onError() {} });
  await entry.drain();
  assert.equal(calls, 0);
  ready = true;
  await entry.drain();
  assert.equal(calls, 1);
});

test('overlapping entry and OAuth visibility events do not duplicate uploads', async () => {
  let finish!: () => void;
  let calls = 0;
  const entry = createEntrySync({ ready: () => true, synchronize: () => { calls++; return new Promise<void>((resolve) => { finish = resolve; }); }, onStart() {}, onError() {} });
  const first = entry.drain();
  entry.request();
  await entry.drain();
  assert.equal(calls, 1);
  finish();
  await first;
  await entry.drain();
  assert.equal(calls, 1);
});

test('authorization failures are surfaced and a later entry can retry', async () => {
  let failures = 0;
  const entry = createEntrySync({ ready: () => true, synchronize: async () => { throw new Error('popup blocked'); }, onStart() {}, onError(error) { assert.match(String(error), /popup blocked/); failures++; } });
  await entry.drain();
  assert.equal(failures, 1);
  entry.request();
  await Promise.resolve();
  assert.equal(failures, 2);
  entry.dispose();
  entry.request();
  await entry.drain();
  assert.equal(failures, 2);
});
