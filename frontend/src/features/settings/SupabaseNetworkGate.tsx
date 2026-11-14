import { useEffect, useState } from 'react';
import { Modal, Platform, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Button';
import { checkSupabaseConnection, continueWithLocalSupabaseLibrary, resumeSupabaseSync, useSupabaseSync } from '@/storage/supabase/sync';
import { colors, spacing } from '@/theme/tokens';
import { t } from '@/i18n';

export function SupabaseNetworkGate() {
  const state = useSupabaseSync();
  const [busy, setBusy] = useState(false);
  const [confirmLocal, setConfirmLocal] = useState(false);
  useEffect(() => {
    if (!state.enabled) return;
    const check = () => { void checkSupabaseConnection(true).then((online) => { if (online) void resumeSupabaseSync(true); }); };
    const offline = () => useSupabaseSync.setState({ network: 'offline' });
    check();
    const timer = setInterval(check, 5000);
    if (Platform.OS === 'web') { window.addEventListener('offline', offline); window.addEventListener('online', check); }
    return () => {
      clearInterval(timer);
      if (Platform.OS === 'web') { window.removeEventListener('offline', offline); window.removeEventListener('online', check); }
    };
  }, [state.enabled]);
  if (!state.enabled || state.localMode || (state.network === 'online' && !state.restoreOnReconnect)) return null;
  return <Modal visible animationType="fade" onRequestClose={() => {}}><View accessibilityViewIsModal style={s.screen}>
    <Text accessibilityRole="header" style={s.title}>{t('supabase.networkTitle')}</Text>
    <Text style={s.text}>{t('supabase.networkMessage')}</Text>
    {state.restoreOnReconnect && state.network !== 'offline' ? <Text style={s.text}>{t('supabase.restoringCloud')}</Text> : null}
    <Button label={t('common.retry')} loading={busy} onPress={() => {
      setBusy(true);
      void checkSupabaseConnection(true).then(() => resumeSupabaseSync(true)).finally(() => setBusy(false));
    }} />
    {confirmLocal ? <>
      <Text style={s.text}>{t('supabase.offlineWarning')}</Text>
      <Button variant="danger" label={t('common.confirm')} disabled={busy} onPress={() => {
        setBusy(true);
        void continueWithLocalSupabaseLibrary().then(() => setConfirmLocal(false)).finally(() => setBusy(false));
      }} />
      <Button variant="secondary" label={t('common.cancel')} disabled={busy} onPress={() => setConfirmLocal(false)} />
    </> : <Button variant="secondary" label={t('supabase.continueLocal')} disabled={busy} onPress={() => setConfirmLocal(true)} />}
  </View></Modal>;
}
const s = StyleSheet.create({
  screen: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 1000, backgroundColor: colors.bg, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  title: { color: colors.text, fontSize: 24, fontWeight: '700', textAlign: 'center' },
  text: { color: colors.textMuted, fontSize: 16, lineHeight: 24, textAlign: 'center' },
});
