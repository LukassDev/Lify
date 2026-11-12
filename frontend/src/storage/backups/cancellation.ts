export class BackupCancelledError extends Error {
  constructor() {
    super('Backup cancelled');
    this.name = 'BackupCancelledError';
  }
}

export interface BackupExportOptions {
  signal?: AbortSignal;
  onReady?: () => void;
}

export function throwIfBackupCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BackupCancelledError();
}
