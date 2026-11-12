import { useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { t } from '@/i18n';
import { colors, spacing } from '@/theme/tokens';
import { loadDrivePreferences, useDriveStore } from '@/storage/drive/sync';
import { driveAccessToken, driveEntryAccessToken, prepareDriveAuth } from '@/storage/drive/auth';
import { createEntrySync } from '@/storage/drive/entrySync';
import { synchronizeDriveNow } from './useDriveBackup';

/** Entry and resume use the same sync flow as the manual button, independent of the interval. */
export function DriveBackupObserver() {
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const connected = useDriveStore((state) => state.connected);
  const automatic = useDriveStore((state) => state.automatic);
  const busy = useDriveStore((state) => state.busy);
  useEffect(() => {
    let active = true;
    prepareDriveAuth();
    const entry = createEntrySync({
      ready: () => {
        const state = useDriveStore.getState();
        return state.loaded && state.connected && state.automatic && !state.busy;
      },
      synchronize: () => synchronizeDriveNow(driveEntryAccessToken()),
      onStart: () => setError(null),
      onError: (failure) => setError(failure instanceof Error ? failure.message : t('common.error')),
    });
    const unsubscribe = useDriveStore.subscribe((state, previous) => {
      if (state.connected !== previous.connected || state.automatic !== previous.automatic) entry.request();
      else void entry.drain();
    });
    void loadDrivePreferences().then(entry.drain).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : t('common.error'));
    });
    const resume = () => entry.request();
    const subscription = AppState.addEventListener('change', (state) => { if (Platform.OS !== 'web' && state === 'active') resume(); });
    const visibility = () => { if (document.visibilityState === 'visible') resume(); };
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false;
      entry.dispose();
      unsubscribe();
      subscription.remove();
      if (Platform.OS === 'web') document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  if (!error || !connected || !automatic) return null;
  return (
    <View accessibilityLiveRegion="polite" style={styles.notice}>
      <Text style={{ color: colors.text }}>{t('drive.entrySyncFailed')} {error}</Text>
      <Button label={t('drive.syncNow')} loading={retrying} disabled={busy} onPress={() => {
        setRetrying(true);
        // Invoke in the click gesture when the browser blocks the automatic popup.
        void synchronizeDriveNow(driveAccessToken(true))
          .then(() => setError(null))
          .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : t('common.error')))
          .finally(() => setRetrying(false));
      }} />
    </View>
  );
}
const styles = StyleSheet.create({
  notice: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: 100, backgroundColor: colors.surface, padding: spacing.md, gap: spacing.sm, borderRadius: 12, zIndex: 100 },
});
