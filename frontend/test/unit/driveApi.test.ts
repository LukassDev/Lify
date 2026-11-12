import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOUD_FILE_NAME, DriveClient, DriveHttpError, type DriveFile } from '../../src/storage/drive/api';

const file: DriveFile = { id: 'backup', name: CLOUD_FILE_NAME, modifiedTime: '2026-11-12T01:30:00Z', size: '12', version: '2', etag: 'old-etag' };
function mock(action: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: string, init: RequestInit) => action(String(url), init)) as typeof fetch;
}

test('Drive listing is restricted to the hidden app folder and the canonical filename', async () => {
  let count = 0;
  const drive = new DriveClient('test-token', mock((url, init) => {
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-token');
    if (++count === 1) {
      const params = new URL(url).searchParams;
      assert.equal(params.get('spaces'), 'appDataFolder');
      assert.ok(params.get('q')?.includes(CLOUD_FILE_NAME));
      return Response.json({ files: [file] });
    }
    return Response.json(file, { headers: { etag: 'latest-etag' } });
  }));
  assert.equal((await drive.latest())?.etag, 'latest-etag');
});

test('resumable create uses appDataFolder and 1 MiB chunks', async () => {
  const data = new Uint8Array(1024 * 1024 + 3);
  let calls = 0;
  const drive = new DriveClient('token', mock((url, init) => {
    calls++;
    if (calls === 1) {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body as string).parents, ['appDataFolder']);
      return new Response(null, { headers: { location: 'https://www.googleapis.com/upload/session' } });
    }
    const headers = init.headers as Record<string, string>;
    if (calls === 2) {
      assert.equal(headers['Content-Range'], `bytes 0-1048575/${data.length}`);
      return new Response(null, { status: 308, headers: { range: 'bytes=0-1048575' } });
    }
    assert.equal(headers['Content-Range'], `bytes 1048576-1048578/${data.length}`);
    return Response.json(file);
  }));
  assert.equal((await drive.upload(data, null)).id, 'backup');
  assert.equal(calls, 3);
});

test('update keeps the same file ID and uses an optimistic write precondition', async () => {
  let calls = 0;
  const drive = new DriveClient('token', mock((url, init) => {
    if (++calls === 1) {
      assert.ok(url.includes('/files/backup?'));
      assert.equal(init.method, 'PATCH');
      assert.equal((init.headers as Record<string, string>)['If-Match'], 'old-etag');
      assert.equal(JSON.parse(init.body as string).parents, undefined);
      return new Response(null, { status: 412 });
    }
    throw new Error('must not upload after a conflict');
  }));
  await assert.rejects(drive.upload(new Uint8Array([1]), file), (error) => error instanceof DriveHttpError && error.status === 412);
  assert.equal(calls, 1);
});

test('lost upload response queries the server offset before resuming', async () => {
  const data = new Uint8Array(1024 * 1024 + 3);
  let calls = 0;
  const drive = new DriveClient('token', mock((_url, init) => {
    calls++;
    if (calls === 1) return new Response(null, { headers: { location: 'https://www.googleapis.com/upload/session' } });
    if (calls === 2) throw new TypeError('network interrupted');
    if (calls === 3) {
      assert.equal((init.headers as Record<string, string>)['Content-Range'], `bytes */${data.length}`);
      return new Response(null, { status: 308, headers: { range: 'bytes=0-1048575' } });
    }
    assert.equal((init.headers as Record<string, string>)['Content-Range'], `bytes 1048576-1048578/${data.length}`);
    return Response.json(file);
  }));
  assert.equal((await drive.upload(data, file)).version, '2');
});

test('download rejects oversized backups and never sends credentials to an untrusted upload host', async () => {
  const drive = new DriveClient('token', mock(() => new Response(null, { headers: { location: 'https://example.com/upload' } })));
  await assert.rejects(drive.download({ ...file, size: '500' }, 100), /size limit/);
  await assert.rejects(drive.upload(new Uint8Array([1]), null), /invalid upload session/);
});
