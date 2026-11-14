import { cloudFileKey, remoteChanged, type RemoteLibrary } from '../backups/cloudPolicy';

export function decideDriveSync(input: {
  remote: RemoteLibrary | null;
  checkpoint: string | null;
  revision: number;
  lastRevision: number | null;
}): 'push' | 'pull' | 'conflict' | 'idle' {
  if (!input.remote) return 'push';
  const localChanged = input.lastRevision === null || input.revision !== input.lastRevision;
  if (remoteChanged(input.remote, input.checkpoint)) return localChanged ? 'conflict' : 'pull';
  return localChanged ? 'push' : 'idle';
}

export function conflictKey(remote: RemoteLibrary, revision: number): string {
  return `${cloudFileKey(remote)}:local:${revision}`;
}
