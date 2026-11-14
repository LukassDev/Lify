import assert from 'node:assert/strict';
import test from 'node:test';
import { decideDriveSync, conflictKey } from '../../src/storage/drive/syncDecision';
import { cloudFileKey, remoteChanged } from '../../src/storage/backups/cloudPolicy';

const file = { id: 'backup', version: '2', md5Checksum: 'content-a' };
const synced = { remote: file, checkpoint: cloudFileKey(file), revision: 12, lastRevision: 12 };

test('reopening an already synchronized library is idle instead of uploading again', () => {
  assert.equal(decideDriveSync(synced), 'idle');
});

test('a remote-only edit is received automatically without a conflict dialog', () => {
  assert.equal(decideDriveSync({ ...synced, remote: { ...file, version: '3', md5Checksum: 'content-b' } }), 'pull');
});

test('a local-only edit is uploaded automatically', () => {
  assert.equal(decideDriveSync({ ...synced, revision: 13 }), 'push');
});

test('both sides changed requires an explicit choice to protect local edits', () => {
  assert.equal(decideDriveSync({ ...synced, revision: 13, remote: { ...file, version: '3', md5Checksum: 'content-b' } }), 'conflict');
});

test('Google metadata version changes with identical content do not cause conflicts', () => {
  const metadataOnly = { ...file, version: '99' };
  assert.equal(remoteChanged(metadataOnly, synced.checkpoint), false);
  assert.equal(decideDriveSync({ ...synced, remote: metadataOnly }), 'idle');
});

test('first connection to an existing cloud library still protects the unknown local state', () => {
  assert.equal(decideDriveSync({ ...synced, checkpoint: null, lastRevision: null }), 'conflict');
  assert.equal(decideDriveSync({ ...synced, remote: null }), 'push');
});

test('legacy version-only checkpoints remain recognized on upgrade', () => {
  assert.equal(remoteChanged(file, 'backup:2'), false);
  assert.equal(decideDriveSync({ ...synced, checkpoint: 'backup:2' }), 'idle');
});

test('dismissal survives reopening and metadata changes, but new local or remote content prompts again', () => {
  const saved = JSON.parse(JSON.stringify({ dismissed: conflictKey(file, 12) }));
  assert.equal(saved.dismissed, conflictKey({ ...file, version: '3' }, 12));
  assert.notEqual(saved.dismissed, conflictKey(file, 13));
  assert.notEqual(saved.dismissed, conflictKey({ ...file, md5Checksum: 'content-b' }, 12));
});
