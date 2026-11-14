// Pure REST client: injectable transport also exercises upload recovery in Node tests.
export const CLOUD_FILE_NAME = 'lify-library.lifybackup';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FIELDS = 'id,name,modifiedTime,size,version,md5Checksum';
const CHUNK_SIZE = 1024 * 1024; // Must be a multiple of 256 KiB.

export interface DriveFile { id: string; name: string; modifiedTime: string; size: string; version: string; md5Checksum?: string; etag?: string }
export class DriveHttpError extends Error {
  constructor(readonly status: number) { super(`Google Drive: HTTP ${status}`); }
}

export class DriveClient {
  // Browser fetch requires its global receiver; storing it directly makes `this`
  // the DriveClient instance and causes "Illegal invocation" in some browsers.
  constructor(private token: string, private transport: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}

  async account(): Promise<{ id: string; label: string }> {
    const response = await this.request('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)');
    if (!response.ok) throw new DriveHttpError(response.status);
    const { user } = await response.json() as { user: { permissionId: string; emailAddress: string } };
    return { id: user.permissionId, label: user.emailAddress };
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      return await this.transport(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${this.token}` }, signal: controller.signal });
    } finally { clearTimeout(timeout); }
  }

  async latest(): Promise<DriveFile | null> {
    const query = new URLSearchParams({ spaces: 'appDataFolder', q: `name = '${CLOUD_FILE_NAME}' and trashed = false`, fields: `files(${FIELDS})`, orderBy: 'modifiedTime desc', pageSize: '1' });
    const response = await this.request(`${API}?${query}`);
    if (!response.ok) throw new DriveHttpError(response.status);
    const file = ((await response.json()) as { files: DriveFile[] }).files[0];
    return file ? this.metadata(file.id) : null;
  }

  async metadata(id: string): Promise<DriveFile> {
    const response = await this.request(`${API}/${encodeURIComponent(id)}?fields=${FIELDS}`);
    if (!response.ok) throw new DriveHttpError(response.status);
    return { ...await response.json() as DriveFile, etag: response.headers.get('etag') ?? undefined };
  }

  async download(file: DriveFile, limit: number): Promise<Uint8Array> {
    if (Number(file.size) > limit) throw new Error('Google Drive: backup exceeds size limit');
    const response = await this.request(`${API}/${encodeURIComponent(file.id)}?alt=media`, { headers: file.etag ? { 'If-Match': file.etag } : {} });
    if (!response.ok) throw new DriveHttpError(response.status);
    const length = Number(response.headers.get('content-length'));
    if (length > limit) throw new Error('Google Drive: backup exceeds size limit');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('Google Drive: backup exceeds size limit');
    return bytes;
  }

  async upload(bytes: Uint8Array, previous: DriveFile | null): Promise<DriveFile> {
    const metadata = previous ? { name: CLOUD_FILE_NAME } : { name: CLOUD_FILE_NAME, parents: ['appDataFolder'] };
    const response = await this.request(`${UPLOAD}${previous ? `/${encodeURIComponent(previous.id)}` : ''}?uploadType=resumable&fields=${FIELDS}`, {
      method: previous ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/zip', 'X-Upload-Content-Length': String(bytes.length),
        ...(previous?.etag ? { 'If-Match': previous.etag } : {}),
      }, body: JSON.stringify(metadata),
    });
    if (!response.ok) throw new DriveHttpError(response.status);
    const location = response.headers.get('location');
    // Never forward an access token to an arbitrary upload host.
    if (!location || new URL(location).origin !== 'https://www.googleapis.com') throw new Error('Google Drive: invalid upload session');
    let offset = 0;
    let failures = 0;
    while (offset < bytes.length) {
      const end = Math.min(offset + CHUNK_SIZE, bytes.length);
      let chunk: Response;
      try {
        chunk = await this.request(location, {
          method: 'PUT', headers: { 'Content-Type': 'application/zip', 'Content-Range': `bytes ${offset}-${end - 1}/${bytes.length}` },
          body: Uint8Array.from(bytes.subarray(offset, end)).buffer,
        });
        if (chunk.status >= 500 || chunk.status === 429) throw new DriveHttpError(chunk.status);
      } catch (error) {
        if (++failures > 3) throw error;
        // Query the acknowledged offset; the failed request may have reached Google.
        chunk = await this.request(location, { method: 'PUT', headers: { 'Content-Range': `bytes */${bytes.length}` } });
      }
      if (chunk.ok) return { ...await chunk.json() as DriveFile, etag: chunk.headers.get('etag') ?? undefined };
      if (chunk.status !== 308) throw new DriveHttpError(chunk.status);
      const range = chunk.headers.get('range');
      const next = range ? Number(range.match(/^bytes=0-(\d+)$/)?.[1]) + 1 : 0;
      if (!Number.isFinite(next) || next < offset || next > end) throw new Error('Google Drive: invalid upload offset');
      if (next === offset && ++failures > 3) throw new Error('Google Drive: upload stalled');
      offset = next;
    }
    throw new Error('Google Drive: incomplete upload');
  }
}
