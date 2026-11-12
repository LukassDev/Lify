import { useCallback, useEffect, useRef, useState } from 'react';
import { requestDialog } from '@/components/OverlayDialogHost';
import { getDb, historyRepo, settingsRepo } from '@/database';
import { exportBackup, importBackup } from '@/storage/backups/backup';
import { BackupCancelledError } from '@/storage/backups/cancellation';
import { configureAutoBackup } from '@/storage/backups/autoBackupTask';
import { cleanupUnreferencedLocalAudio } from '@/storage/localAudioCleanup';
import { isStreamServerConfigured, normalizeStreamServerUrl } from '@/services/catalog/server';
import { useStartupStore } from '@/services/startup';
import { DEFAULT_SETTINGS, type AppSettings } from '@/types';
import { setLanguage, t } from '@/i18n';

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [serverSaveState, setServerSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [exportState, setExportState] = useState<'generating' | 'cancelling' | null>(null);
  const exportController = useRef<AbortController | null>(null);

  useEffect(() => () => { exportController.current?.abort(); }, []);

  useEffect(() => {
    getDb()
      .then((db) => settingsRepo.loadSettings(db))
      .then((loadedSettings) => {
        setSettings(loadedSettings);
        useStartupStore.getState().setStreamServerConfigured(isStreamServerConfigured(loadedSettings));
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : t('settings.loadFailed'));
      });
  }, []);

  const update = useCallback(async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setMessage(null);
    try {
      if (key === 'autoBackupIntervalDays') {
        if (typeof value !== 'number') throw new TypeError('Automatic backup interval must be numeric');
        await configureAutoBackup(value);
      }
      await settingsRepo.saveSetting(await getDb(), key, value);
      if (key === 'language') setLanguage(value as AppSettings['language']);
      setSettings((s) => ({ ...s, [key]: value }));
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('settings.saveFailed'));
      return false;
    }
  }, []);

  const saveCustomServer = useCallback(async (value: string) => {
    if (busy) return;
    setBusy(true);
    setServerSaveState('saving');
    setMessage(null);

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeStreamServerUrl(value);
    } catch (error) {
      setServerSaveState('idle');
      setMessage(error instanceof Error ? error.message : t('settings.invalidServer'));
      setBusy(false);
      return;
    }

    try {
      if (await update('customStreamServerUrl', normalizedUrl)) {
        useStartupStore.getState().setStreamServerConfigured(true);
        setServerSaveState('saved');
        setMessage(t('settings.serverSelected'));
      } else {
        setServerSaveState('idle');
      }
    } finally {
      setBusy(false);
    }
  }, [busy, update]);

  const resetServerSaveState = useCallback(() => setServerSaveState('idle'), []);

  const guarded = useCallback(async (fn: () => Promise<string>) => {
    setBusy(true); setMessage(null);
    try { setMessage(await fn()); }
    catch (e) { setMessage(e instanceof Error ? e.message : t('common.error')); }
    finally { setBusy(false); }
  }, []);

  const cancelExport = useCallback(() => {
    if (!exportController.current || exportController.current.signal.aborted) return;
    setExportState('cancelling');
    exportController.current.abort();
  }, []);

  const doExport = useCallback(async (includeDownloads: boolean) => {
    if (busy || exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setBusy(true);
    setMessage(null);
    setExportState('generating');
    try {
      const r = await exportBackup(includeDownloads, {
        signal: controller.signal,
        onReady: () => {
          exportController.current = null;
          setExportState(null);
        },
      });
      setMessage(r.shared
        ? includeDownloads ? t('settings.exported') : t('settings.exportedWithoutDownloads')
        : includeDownloads
          ? t('settings.exportedAt', { uri: r.uri })
          : t('settings.exportedAtWithoutDownloads', { uri: r.uri }));
    } catch (error) {
      setMessage(error instanceof BackupCancelledError || controller.signal.aborted
        ? t('settings.exportCancelled')
        : error instanceof Error ? error.message : t('common.error'));
    } finally {
      exportController.current = null;
      setExportState(null);
      setBusy(false);
    }
  }, [busy]);

  const doImport = useCallback(() => {
    void requestDialog({
      title: t('settings.importTitle'),
      message: t('settings.importMessage'),
      confirmLabel: t('settings.importPick'),
    }).then((confirmed) => {
      if (!confirmed) return;
      void guarded(async () => {
        const r = await importBackup();
        if (r.status === 'cancelled') return t('settings.importCancelled');
        await cleanupUnreferencedLocalAudio();
        const loaded = await settingsRepo.loadSettings(await getDb());
        await configureAutoBackup(loaded.autoBackupIntervalDays);
        setSettings(loaded);
        setLanguage(loaded.language);
        useStartupStore.getState().setStreamServerConfigured(isStreamServerConfigured(loaded));
        return t('settings.importDone');
      });
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : t('common.error')));
  }, [guarded]);

  const clearHistory = useCallback(() => {
    void requestDialog({
      title: t('settings.clearHistoryConfirmTitle'),
      message: t('settings.clearHistoryConfirmMessage'),
      confirmLabel: t('settings.clearHistory'),
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) {
        void guarded(async () => {
        await historyRepo.clearHistory(await getDb());
        return t('settings.historyCleared');
      });
      }
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : t('common.error')));
  }, [guarded]);

  return {
    settings,
    update,
    saveCustomServer,
    serverSaveState,
    resetServerSaveState,
    busy,
    message,
    doExport,
    exporting: exportState !== null,
    exportCancelling: exportState === 'cancelling',
    cancelExport,
    doImport,
    clearHistory,
  };
}
