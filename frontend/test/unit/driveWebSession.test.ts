import assert from 'node:assert/strict';
import test from 'node:test';
import { DRIVE_SESSION_KEY, readWebDriveSession, validGoogleClientId, writeWebDriveSession } from '../../src/storage/drive/webSession';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test('a valid browser session survives a page refresh for the same OAuth client', () => {
  const local = storage();
  const session = { clientId: '123-test.apps.googleusercontent.com', value: 'user-token', expiresAt: 3600000 };
  writeWebDriveSession(local, session);
  assert.deepEqual(readWebDriveSession(local, session.clientId, 1000), session);
});

test('changing the OAuth client cannot reuse the previous user authorization', () => {
  const local = storage();
  writeWebDriveSession(local, { clientId: 'old', value: 'token', expiresAt: 3600000 });
  assert.equal(readWebDriveSession(local, 'new', 1000), null);
  assert.equal(local.getItem(DRIVE_SESSION_KEY), null);
});

test('expired and nearly expired sessions require renewed authorization', () => {
  const local = storage();
  for (const expiresAt of [100, 59999, 60000]) {
    writeWebDriveSession(local, { clientId: 'client', value: 'token', expiresAt });
    assert.equal(readWebDriveSession(local, 'client', 0), null);
  }
});

test('corrupt browser storage does not prevent a fresh login', () => {
  const local = storage();
  local.setItem(DRIVE_SESSION_KEY, '{broken');
  assert.equal(readWebDriveSession(local, 'client'), null);
});

test('Client ID accepts Google identifiers and rejects secrets and arbitrary URLs', () => {
  assert.equal(validGoogleClientId('1234567890-abc123.apps.googleusercontent.com'), true);
  for (const value of ['', 'https://example.com', 'GOCSPX-secret', 'id.apps.googleusercontent.com.evil.com']) assert.equal(validGoogleClientId(value), false);
});
