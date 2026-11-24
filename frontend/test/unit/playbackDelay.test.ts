import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackDelay, waitForPlayback } from '../../src/services/audio/playbackDelay';

test('rapid selections only start work for the last track', async () => {
  const delay = new PlaybackDelay();
  const requested: number[] = [];
  const select = (id: number) => waitForPlayback(delay.begin(), 15)
    .then(() => { requested.push(id); }).catch((error) => { assert.equal(error.name, 'AbortError'); });
  await Promise.all([select(1), select(2), select(3)]);
  assert.deepEqual(requested, [3]);
});

test('stop cancels a waiting selection and an already cancelled signal rejects', async () => {
  const delay = new PlaybackDelay();
  const signal = delay.begin();
  const pending = waitForPlayback(signal, 1000);
  delay.cancel();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(waitForPlayback(signal), { name: 'AbortError' });
});
