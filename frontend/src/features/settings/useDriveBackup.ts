import { useEffect, useState } from 'react';
import { requestChoiceDialog, requestDialog } from '@/components/OverlayDialogHost';
import { getDb, settingsRepo } from '@/database';
import { setLanguage, t } from '@/i18n';
import { prepareDriveAuth, driveAccessToken, getDriveClientId, setDriveClientId } from '@/storage/drive/auth';
import {
  checkDriveBackup, CloudConflictError, connectDrive, disconnectDrive, loadDrivePreferences,
  pullDriveBackup, pushDriveBackup, setDriveAutomatic, useDriveStore,
} from '@/storage/drive/sync';
import type { DriveFile } from '@/storage/drive/api';
import { bumpFavoritesVersion } from '@/features/favorites/favoriteFeedback';
import { notifyLibraryRestored } from '@/utils/libraryEvents';

export async function restoreDriveWithConfirmation(file: DriveFile): Promise<boolean> {
  const confirmed = await requestDialog({
    title: t('drive.restoreTitle'),
    message: t('drive.restoreMessage', { date: new Date(file.modifiedTime).toLocaleString() }),
    confirmLabel: t('drive.restore'), destructive: true,
  });
  if (!confirmed) return false;
  await pullDriveBackup(file);
  setLanguage((await settingsRepo.loadSettings(await getDb())).language);
  bumpFavoritesVersion();
  notifyLibraryRestored();
  return true;
}

export async function synchronizeDriveNow(authorization: Promise<string>): Promise<boolean> {
  await connectDrive(await authorization);
  try { await pushDriveBackup(); }
  catch (error) {
    if (!(error instanceof CloudConflictError)) throw error;
    const choice = await requestChoiceDialog({
      title: t('drive.conflictTitle'),
      message: t('drive.conflictMessage', { date: new Date(error.file.modifiedTime).toLocaleString() }),
      choices: [
        { label: t('common.cancel'), value: 'cancel' },
        { label: t('drive.restore'), value: 'restore' },
        { label: t('drive.replaceCloud'), value: 'replace', destructive: true },
      ],
    });
    if (choice === 'cancel') return false;
    if (choice === 'restore') {
      if (!await restoreDriveWithConfirmation(error.file)) return false;
    } else await pushDriveBackup(`${error.file.id}:${error.file.version}`);
  }
  return true;
}

export function useDriveBackup() {
  const drive = useDriveStore();
  const [authorizing, setAuthorizing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  useEffect(() => {
    prepareDriveAuth();
    void loadDrivePreferences().catch((error: unknown) => setMessage(String(error)));
    void getDriveClientId().then(setClientId).catch((error: unknown) => setMessage(String(error)));
  }, []);

  async function perform(action: () => Promise<void>) {
    setMessage(null);
    try { await action(); }
    catch (error) { setMessage(error instanceof Error ? error.message : t('common.error')); }
  }

  function connect() {
    setAuthorizing(true);
    // Invoke directly in the button gesture; browsers block unsolicited OAuth popups.
    const authorization = driveAccessToken(true, true);
    void perform(async () => {
      try {
        await connectDrive(await authorization);
        const remote = await checkDriveBackup();
        if (remote) await restoreDriveWithConfirmation(remote);
        setMessage(t('drive.connected'));
      } finally { setAuthorizing(false); }
    });
  }

  function syncNow() {
    setAuthorizing(true);
    const authorization = driveAccessToken(true);
    void perform(async () => {
      try {
        if (!await synchronizeDriveNow(authorization)) return;
        setMessage(t('drive.syncDone'));
      } finally { setAuthorizing(false); }
    });
  }

  return {
    clientId, setClientId,
    saveClientId: () => void perform(async () => {
      if (drive.busy || authorizing) throw new Error(t('drive.busy'));
      if (drive.connected) throw new Error(t('drive.disconnectBeforeConfig'));
      await setDriveClientId(clientId);
      setClientId(await getDriveClientId());
      setMessage(t('drive.clientIdSaved'));
    }),
    drive, working: drive.busy || authorizing, message: message ?? drive.error,
    connect, syncNow,
    disconnect: () => void perform(async () => { await disconnectDrive(); setMessage(t('drive.disconnected')); }),
    toggleAutomatic: (value: boolean) => void perform(() => setDriveAutomatic(value)),
    restore: () => void perform(async () => {
      const file = useDriveStore.getState().remote;
      if (file && await restoreDriveWithConfirmation(file)) setMessage(t('drive.restored'));
    }),
  };
}
