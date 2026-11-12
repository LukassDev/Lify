import { create } from 'zustand';
import { getDb, settingsRepo } from '@/database';
import { getDeviceState, setDeviceState } from '@/database/device';
import { createCloudArchive, libraryRevision, restoreCloudArchive } from '@/storage/backups/cloudArchive';
import { MAX_CLOUD_BYTES, remoteChanged } from '@/storage/backups/cloudPolicy';
import { isAutoBackupDue } from '@/storage/backups/schedule';
import { driveAccessToken, disconnectDriveAuth, invalidateDriveToken } from './auth';
import { DriveClient, DriveHttpError, type DriveFile } from './api';
import { t } from '@/i18n';

interface DrivePreferences {
  connected: boolean;
  automatic: boolean;
  accountId: string | null;
  accountLabel: string | null;
  checkpoint: string | null;
  lastBackupAt: number | null;
  lastRevision: number | null;
}
const defaults: DrivePreferences = { connected: false, automatic: false, accountId: null, accountLabel: null, checkpoint: null, lastBackupAt: null, lastRevision: null };
interface DriveStore extends DrivePreferences {
  loaded: boolean;
  busy: boolean;
  remote: DriveFile | null;
  error: string | null;
}
export const useDriveStore = create<DriveStore>(() => ({ ...defaults, loaded: false, busy: false, remote: null, error: null }));
let loading: Promise<void> | null = null;
const key = (file: DriveFile) => `${file.id}:${file.version}`;

export async function loadDrivePreferences(): Promise<void> {
  if (useDriveStore.getState().loaded) return;
  if (!loading) loading = (async () => {
    const preferences = await getDeviceState('googleDrive', defaults);
    useDriveStore.setState({ ...defaults, ...preferences, loaded: true });
  })().finally(() => { loading = null; });
  return loading;
}

async function persist(patch: Partial<DrivePreferences>): Promise<void> {
  const current = useDriveStore.getState();
  const preferences = Object.fromEntries(Object.keys(defaults).map((name) => [name, current[name as keyof DrivePreferences]])) as unknown as DrivePreferences;
  await setDeviceState('googleDrive', { ...preferences, ...patch });
  useDriveStore.setState(patch);
}

async function exclusive<T>(action: () => Promise<T>): Promise<T> {
  await loadDrivePreferences();
  if (useDriveStore.getState().busy) throw new Error(t('drive.busy'));
  useDriveStore.setState({ busy: true, error: null });
  try { return await action(); }
  catch (error) {
    useDriveStore.setState({ error: error instanceof Error ? error.message : t('common.error') });
    throw error;
  } finally { useDriveStore.setState({ busy: false }); }
}

async function client(): Promise<DriveClient> {
  const state = useDriveStore.getState();
  if (!state.connected) throw new Error(t('drive.reauthorize'));
  const token = await driveAccessToken();
  const drive = new DriveClient(token);
  try {
    const account = await drive.account();
    if (account.id !== state.accountId) throw new Error(t('drive.accountChanged'));
    return drive;
  } catch (error) {
    if (error instanceof DriveHttpError && error.status === 401) {
      await invalidateDriveToken(token);
      throw new Error(t('drive.reauthorize'));
    }
    throw error;
  }
}

export async function connectDrive(token: string): Promise<void> {
  return exclusive(async () => {
    const drive = new DriveClient(token);
    const account = await drive.account();
    const previous = useDriveStore.getState();
    await persist({
      connected: true, accountId: account.id, accountLabel: account.label,
      ...(previous.accountId !== account.id ? { checkpoint: null, lastBackupAt: null, lastRevision: null } : {}),
    });
    useDriveStore.setState({ remote: await drive.latest() });
  });
}

export async function disconnectDrive(): Promise<void> {
  return exclusive(async () => {
    await disconnectDriveAuth();
    await persist({ connected: false, automatic: false });
    useDriveStore.setState({ remote: null });
  });
}

export async function setDriveAutomatic(automatic: boolean): Promise<void> {
  await exclusive(() => persist({ automatic }));
}

export async function checkDriveBackup(): Promise<DriveFile | null> {
  return exclusive(async () => {
    const remote = await (await client()).latest();
    useDriveStore.setState({ remote });
    return remoteChanged(remote, useDriveStore.getState().checkpoint) ? remote : null;
  });
}

export class CloudConflictError extends Error {
  constructor(readonly file: DriveFile) { super(t('drive.conflict')); }
}

export async function pushDriveBackup(replaceVersion?: string): Promise<void> {
  return exclusive(async () => {
    const drive = await client();
    const remote = await drive.latest();
    useDriveStore.setState({ remote });
    const state = useDriveStore.getState();
    if (remoteChanged(remote, state.checkpoint) && (!remote || key(remote) !== replaceVersion)) throw new CloudConflictError(remote!);
    const archive = await createCloudArchive();
    // Recheck after serialization as another device may have uploaded meanwhile.
    const latest = await drive.latest();
    if ((latest ? key(latest) : null) !== (remote ? key(remote) : null)) {
      if (latest) throw new CloudConflictError(latest);
      throw new Error(t('drive.remoteChanged'));
    }
    const uploaded = await drive.upload(archive.bytes, latest);
    await persist({ checkpoint: key(uploaded), lastBackupAt: Date.now(), lastRevision: archive.revision });
    useDriveStore.setState({ remote: uploaded });
  });
}

export async function pullDriveBackup(expected: DriveFile): Promise<void> {
  return exclusive(async () => {
    const drive = await client();
    const latest = await drive.latest();
    if (!latest || key(latest) !== key(expected)) throw new Error(t('drive.remoteChanged'));
    const revision = await libraryRevision();
    const bytes = await drive.download(latest, MAX_CLOUD_BYTES + 4096);
    // Edits during the network transfer require a fresh user confirmation.
    if (await libraryRevision() !== revision) throw new Error(t('drive.localChanged'));
    await restoreCloudArchive(bytes, revision);
    await persist({ checkpoint: key(latest), lastBackupAt: Date.now(), lastRevision: await libraryRevision() });
    useDriveStore.setState({ remote: latest });
  });
}

export async function runCloudBackupIfDue(): Promise<boolean> {
  await loadDrivePreferences();
  const state = useDriveStore.getState();
  if (!state.connected || !state.automatic || state.busy) return false;
  const settings = await settingsRepo.loadSettings(await getDb());
  if (!isAutoBackupDue(settings.autoBackupIntervalDays, state.lastBackupAt)) return false;
  try {
    // Even an unchanged local library must discover another device's new backup.
    const remote = await checkDriveBackup();
    if (remote) return false;
    if (state.lastRevision === await libraryRevision()) return false;
    await pushDriveBackup();
    return true;
  } catch (error) {
    console.warn('[drive] Automatic backup deferred', error);
    return false;
  }
}
