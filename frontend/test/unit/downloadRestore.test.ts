import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadRestoreMode } from '../../src/storage/backups/downloadRestore';

test('a backup without downloaded music discards stale download rows', () => {
  assert.equal(downloadRestoreMode(['song-1'], new Map()), 'omit');
  assert.equal(downloadRestoreMode(['song-1']), 'omit');
});

test('a backup with every downloaded song restores its download rows', () => {
  assert.equal(downloadRestoreMode(['song-1', 'song-2'], new Map([
    ['song-1', 'audio-1'],
    ['song-2', 'audio-2'],
  ])), 'restore');
});

test('a backup with only some downloaded songs remains invalid', () => {
  assert.equal(downloadRestoreMode(['song-1', 'song-2'], new Map([['song-1', 'audio-1']])), 'invalid');
  assert.equal(downloadRestoreMode(['song-1'], new Map([['other-song', 'audio-1']])), 'invalid');
});
