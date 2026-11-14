import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Button } from '@/components/Button';
import { requestDialog } from '@/components/OverlayDialogHost';
import { colors, font, spacing } from '@/theme/tokens';
import { authenticateSupabase, configureSupabase, enableSupabaseSync, loadSupabaseSync, signOutSupabase, useSupabaseSync } from '@/storage/supabase/sync';
import { SUPABASE_SETUP_SQL } from '@/storage/supabase/setup';
import { t } from '@/i18n';
import { getDeviceState } from '@/database/device';

export function SupabaseSettings() {
  const sync = useSupabaseSync();
  const [url, setUrl] = useState(''), [key, setKey] = useState('');
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [guide, setGuide] = useState(false), [message, setMessage] = useState<string | null>(null);
  useEffect(() => { void loadSupabaseSync(); }, []);
  useEffect(() => { setUrl(sync.url); setKey(sync.key); }, [sync.url, sync.key]);
  const perform = async (action: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(true); setMessage(null);
    try { setMessage(await action() || null); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const login = (signup: boolean) => void perform(async () => {
    try { return await authenticateSupabase(email, password, signup); }
    finally { setPassword(''); }
  });
  return <View style={s.card}>
    <Button label={t(guide ? 'drive.hideGuide' : 'supabase.guideButton')} variant="secondary" onPress={() => setGuide(!guide)} />
    {guide ? <>
      <Text selectable style={s.hint}>{t('supabase.guide')}</Text>
      <Button icon="copy-outline" variant="secondary" label={t('supabase.copySql')} onPress={() => void perform(async () => { await Clipboard.setStringAsync(SUPABASE_SETUP_SQL); return t('supabase.sqlCopied'); })} />
      <Pressable accessibilityRole="link" onPress={() => void Linking.openURL('https://supabase.com/dashboard')}><Text style={{ color: colors.accent }}>{t('supabase.openDashboard')}</Text></Pressable>
    </> : null}
    <Text style={s.label}>{t('supabase.projectUrl')}</Text>
    <TextInput accessibilityLabel={t('supabase.projectUrl')} editable={!sync.userId && !busy} value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} placeholder="https://project.supabase.co" placeholderTextColor={colors.textFaint} style={s.input} />
    <Text style={s.label}>{t('supabase.publicKey')}</Text>
    <TextInput accessibilityLabel={t('supabase.publicKey')} editable={!sync.userId && !busy} value={key} onChangeText={setKey} autoCapitalize="none" autoCorrect={false} placeholder="sb_publishable_... / anon" placeholderTextColor={colors.textFaint} style={s.input} />
    <Button label={t('supabase.saveProject')} disabled={busy || !!sync.userId} variant="secondary" onPress={() => void perform(async () => { await configureSupabase(url, key); return t('supabase.projectSaved'); })} />
    {sync.userId ? <>
      <Text style={s.label}>{sync.email}</Text>
      <View style={s.row}>
        <Text style={[s.label, { flex: 1 }]}>{t('supabase.enable')}</Text>
        <Switch accessibilityLabel={t('supabase.enable')} value={sync.enabled} disabled={busy} trackColor={{ true: colors.accent }} onValueChange={(enabled) => void perform(async () => {
          const drive = await getDeviceState('googleDrive', { connected: false });
          if (enabled && !await requestDialog({ title: t('supabase.enable'), message: t(drive.connected ? 'sync.switchToSupabase' : 'supabase.confirmEnable', { email: sync.email ?? '', url: sync.url }) + '\n\n' + t('supabase.offlineWarning') })) return;
          await enableSupabaseSync(enabled);
        })} />
      </View>
      <Text accessibilityLiveRegion="polite" style={s.hint}>{t(`supabase.status.${sync.status}`)} · {t('supabase.pending', { count: sync.pending })}</Text>
      {sync.lastSyncAt ? <Text style={s.hint}>{t('drive.lastSync', { date: new Date(sync.lastSyncAt).toLocaleString() })}</Text> : null}
      <Button variant="secondary" label={t('supabase.signOut')} disabled={busy} onPress={() => void perform(() => signOutSupabase())} />
    </> : <>
      <Text style={s.label}>{t('supabase.email')}</Text>
      <TextInput accessibilityLabel={t('supabase.email')} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" style={s.input} />
      <Text style={s.label}>{t('supabase.password')}</Text>
      <TextInput accessibilityLabel={t('supabase.password')} value={password} onChangeText={setPassword} secureTextEntry style={s.input} />
      <Button label={t('supabase.signIn')} loading={busy} disabled={!sync.url || !email || !password} onPress={() => login(false)} />
      <Button label={t('supabase.signUp')} variant="secondary" disabled={busy || !sync.url || !email || password.length < 6} onPress={() => login(true)} />
    </>}
    {message || sync.error ? <Text accessibilityLiveRegion="polite" style={s.message}>{message ?? sync.error}</Text> : null}
  </View>;
}
const s = StyleSheet.create({
  card: { backgroundColor: colors.surface, padding: spacing.md, borderRadius: 16, gap: spacing.sm },
  heading: { color: colors.text, fontSize: font.lg, fontWeight: '800' },
  label: { color: colors.text, fontSize: font.md }, hint: { color: colors.textMuted, fontSize: font.sm, lineHeight: 21 },
  input: { backgroundColor: colors.surfaceAlt, borderRadius: 8, padding: 12, color: colors.text, minHeight: 44 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, message: { color: colors.accent, fontSize: font.sm },
});
