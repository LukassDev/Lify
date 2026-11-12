import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import { Button, Icon, type IconName } from '@/components';
import { useSettings } from '@/features/settings/useSettings';
import { useDriveBackup } from '@/features/settings/useDriveBackup';
import { t, useTranslation } from '@/i18n';
import { colors, font, layout, radius, spacing } from '@/theme/tokens';
import { Dialog } from '@/components/Overlays';
import { showToast } from '@/components/overlay/ToastHost';

const ANDROID_SIGNING_SHA1 = 'BC:58:FF:31:6C:E8:A0:DA:A8:37:54:8E:82:83:5E:FF:63:73:99:32';

export default function Settings() {
  useTranslation();
  const cloud = useDriveBackup();
  const {
    settings,
    update,
    saveCustomServer,
    serverSaveState,
    resetServerSaveState,
    busy,
    message,
    doExport,
    exporting,
    exportCancelling,
    cancelExport,
    doImport,
    clearHistory,
  } = useSettings();
  const [customServerUrl, setCustomServerUrl] = useState(settings.customStreamServerUrl);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [showDriveGuide, setShowDriveGuide] = useState(false);
  useEffect(() => { setCustomServerUrl(settings.customStreamServerUrl); }, [settings.customStreamServerUrl]);

  const driveGuideSteps = t(Platform.OS === 'android' ? 'drive.androidGuide' : Platform.OS === 'web' ? 'drive.webGuide' : 'drive.iosGuide', {
    origin: Platform.OS === 'web' ? window.location.origin : '',
    package: Constants.expoConfig?.android?.package ?? 'com.lify.app',
  }).split('\n');

  const copySigningSha1 = async () => {
    try {
      await Clipboard.setStringAsync(ANDROID_SIGNING_SHA1);
      showToast(t('drive.sha1Copied'));
    } catch {
      showToast(t('drive.sha1CopyFailed'), { icon: 'warning-outline' });
    }
  };

  return (
    <>
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={s.content}>
      <Section title={t('settings.language')} hint={t('settings.languageHint')}>
        <RadioRow label={t('settings.portuguese')} selected={settings.language === 'pt'} onPress={() => update('language', 'pt')} />
        <RadioRow label={t('settings.english')} selected={settings.language === 'en'} onPress={() => update('language', 'en')} />
      </Section>

      <Section title={t('settings.playback')}>
        <Text style={s.hint}>{t('settings.audioQualityStandard')}</Text>
        <ToggleRow icon="time-outline" label={t('settings.history')} hint={t('settings.historyHint')}
          value={settings.historyEnabled} onChange={(v) => update('historyEnabled', v)} />
      </Section>

      <Section title={t('settings.server')} hint={t('settings.serverHint')}>
        <TextInput
          accessibilityLabel={t('settings.serverCustomA11y')}
          autoCapitalize="none" autoCorrect={false} keyboardType="url"
          onChangeText={(value) => {
            setCustomServerUrl(value);
            resetServerSaveState();
          }} value={customServerUrl}
          placeholder="https://server.example.com" placeholderTextColor={colors.textFaint}
          style={[s.input, serverSaveState === 'saved' && s.serverSavedInput]}
        />
        <Button
          label={t(serverSaveState === 'saved' ? 'settings.serverSaved' : 'settings.serverSave')}
          icon={serverSaveState === 'saved' ? 'checkmark' : undefined}
          onPress={() => saveCustomServer(customServerUrl)}
          loading={serverSaveState === 'saving'}
          disabled={busy}
        />
        {serverSaveState === 'saved' ? (
          <Text accessibilityRole="text" style={s.serverSaved}>{t('settings.serverSelected')}</Text>
        ) : null}
        <Text style={s.hint}>{t('settings.serverCustomHint')}</Text>
      </Section>

      <Section title={t('settings.backup')} hint={t(Platform.OS === 'web' ? 'settings.webBackupHint' : 'settings.backupHint')}>
        <Text style={s.label}>{t('settings.autoBackupInterval')}</Text>
        {([0, 1, 7, 30] as const).map((days) => (
          <RadioRow
            key={days}
            label={t(`settings.autoBackupInterval.${days}`)}
            selected={settings.autoBackupIntervalDays === days}
            onPress={() => void update('autoBackupIntervalDays', days)}
          />
        ))}
        {settings.lastAutoBackupAt ? (
          <Text style={s.hint}>{t('settings.lastAutoBackup', {
            date: new Date(settings.lastAutoBackupAt).toLocaleString(),
          })}</Text>
        ) : null}
        <Button icon="share-outline" label={t('settings.export')} onPress={() => setShowExportOptions(true)} disabled={busy} />
        <Button icon="download-outline" variant="secondary" label={t('settings.import')} onPress={doImport} disabled={busy} />
      </Section>

      <Section title="Google Drive">
        <Button variant="secondary" label={t(showDriveGuide ? 'drive.hideGuide' : 'drive.showGuide')} onPress={() => setShowDriveGuide((value) => !value)} />
        {showDriveGuide ? (
          <View style={s.driveGuide}>
            {driveGuideSteps.map((step, index) => (
              <View key={index} style={s.guideStep}>
                <View style={s.guideStepNumber}><Text style={s.guideStepNumberText}>{index + 1}</Text></View>
                <Text selectable style={s.guideStepText}>{step.replace(/^\d+\.\s*/, '')}</Text>
              </View>
            ))}
            {Platform.OS === 'android' ? (
              <View style={s.sha1Block}>
                <Text style={s.guideLabel}>{t('drive.signingSha1')}</Text>
                <Text selectable style={s.sha1Value}>{ANDROID_SIGNING_SHA1}</Text>
                <Button icon="copy-outline" variant="secondary" label={t('drive.copySha1')} onPress={() => void copySigningSha1()} />
              </View>
            ) : null}
            <Pressable accessibilityRole="link" onPress={() => void Linking.openURL('https://console.cloud.google.com/')} style={s.guideLink}>
              <Icon name="open-outline" size={16} color={colors.accent} />
              <Text style={s.guideLinkText}>{t('drive.openConsole')}</Text>
            </Pressable>
          </View>
        ) : null}
        {Platform.OS === 'web' ? <>
          <Text style={s.label}>{t('drive.clientId')}</Text>
          <TextInput accessibilityLabel={t('drive.clientId')} autoCapitalize="none" autoCorrect={false}
            editable={!cloud.working && !cloud.drive.connected} value={cloud.clientId} onChangeText={cloud.setClientId}
            placeholder="1234567890-abc123.apps.googleusercontent.com" placeholderTextColor={colors.textFaint} style={s.input} />
          <Button variant="secondary" label={t('drive.saveClientId')} onPress={cloud.saveClientId} disabled={busy || cloud.working || cloud.drive.connected} />
          {cloud.drive.connected ? <Text style={s.hint}>{t('drive.disconnectBeforeConfig')}</Text> : null}
        </> : null}
        <Text style={s.hint}>{Platform.OS === 'web' ? t('drive.webHint') : t('drive.nativeHint')}</Text>
        {cloud.drive.connected ? (
          <>
            <Text style={s.label}>{cloud.drive.accountLabel}</Text>
            <ToggleRow icon="cloud-upload-outline" label={t('drive.automatic')} hint={t('drive.scheduleHint')}
              value={cloud.drive.automatic} onChange={cloud.toggleAutomatic} />
            {cloud.drive.lastBackupAt ? <Text style={s.hint}>{t('drive.lastSync', { date: new Date(cloud.drive.lastBackupAt).toLocaleString() })}</Text> : null}
            {cloud.drive.remote ? <Text style={s.hint}>{t('drive.cloudDate', { date: new Date(cloud.drive.remote.modifiedTime).toLocaleString() })}</Text> : null}
            <Button icon="sync-outline" label={t('drive.syncNow')} onPress={cloud.syncNow} loading={cloud.working} disabled={busy} />
            <Button icon="download-outline" variant="secondary" label={t('drive.restore')} onPress={cloud.restore} disabled={busy || cloud.working || !cloud.drive.remote} />
            <Button variant="secondary" label={t('drive.reconnect')} onPress={cloud.connect} disabled={busy || cloud.working} />
            <Button variant="secondary" label={t('drive.disconnect')} onPress={cloud.disconnect} disabled={busy || cloud.working} />
          </>
        ) : <Button icon="cloud-outline" label={t('drive.connect')} onPress={cloud.connect} loading={cloud.working} disabled={busy} />}
        {cloud.message ? <Text accessibilityLiveRegion="polite" style={s.msg}>{cloud.message}</Text> : null}
      </Section>

      <Section title={t('settings.data')}>
        <Button icon="trash-outline" variant="danger" label={t('settings.clearHistory')} onPress={clearHistory} disabled={busy} />
      </Section>

      {message ? <Text style={s.msg}>{message}</Text> : null}

      <Text style={s.version}>Lify · {t('settings.version', { version: Constants.expoConfig?.version ?? '1.2.2' })}</Text>
    </ScrollView>
    <Dialog
      visible={showExportOptions}
      onClose={() => setShowExportOptions(false)}
      title={t('settings.exportOptionsTitle')}
    >
          <Text style={s.hint}>{t('settings.exportOptionsMessage')}</Text>
          <Button
            icon="download-outline"
            label={t('settings.exportWithDownloads')}
            onPress={() => {
              setShowExportOptions(false);
              void doExport(true);
            }}
            disabled={busy}
            style={s.dialogButton}
          />
          <Button
            icon="flash-outline"
            variant="secondary"
            label={t('settings.exportWithoutDownloads')}
            onPress={() => {
              setShowExportOptions(false);
              void doExport(false);
            }}
            disabled={busy}
            style={s.dialogButton}
          />
          <Button
            variant="secondary"
            label={t('common.cancel')}
            onPress={() => setShowExportOptions(false)}
            disabled={busy}
            style={s.dialogButton}
          />
    </Dialog>
    <Dialog
      visible={exporting}
      onClose={cancelExport}
      title={t('settings.exportGeneratingTitle')}
      closeOnBackdrop={false}
      busy={exportCancelling}
    >
      <ActivityIndicator size="large" color={colors.accent} />
      <Text accessibilityLiveRegion="polite" style={s.hint}>
        {t(exportCancelling ? 'settings.exportCancelling' : 'settings.exportGeneratingMessage')}
      </Text>
      <Button
        variant="secondary"
        label={t('common.cancel')}
        onPress={cancelExport}
        disabled={exportCancelling}
        style={s.dialogButton}
      />
    </Dialog>
    </>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={s.card}>
      <Text accessibilityRole="header" style={s.section}>{title}</Text>
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

function ToggleRow({ icon, label, hint, value, onChange }: { icon: IconName; label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.row}>
      <Icon name={icon} size={22} color={colors.textMuted} />
      <View style={{ flex: 1 }}>
        <Text style={s.label}>{label}</Text>
        {hint ? <Text style={s.hint}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.accent, false: colors.elevated }} thumbColor={colors.text} />
    </View>
  );
}

function RadioRow({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={onPress} style={s.row}>
      <View style={[s.radio, selected && s.radioOn]}>{selected ? <View style={s.radioDot} /> : null}</View>
      <Text style={s.label}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: layout.listBottomPad + spacing.xl },
  dialogButton: { width: '100%', minHeight: 48, borderRadius: 8 },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm },
  section: { color: colors.text, fontSize: font.lg, fontWeight: '800' },
  hint: { color: colors.textMuted, fontSize: font.sm },
  driveGuide: { padding: spacing.md, gap: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  guideStep: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  guideStepNumber: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt },
  guideStepNumberText: { color: colors.accent, fontSize: font.sm, fontWeight: '700' },
  guideStepText: { flex: 1, minWidth: 0, color: colors.textMuted, fontSize: font.sm, lineHeight: 20 },
  guideLabel: { color: colors.text, fontSize: font.sm, fontWeight: '600' },
  sha1Block: { gap: spacing.sm, paddingTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  sha1Value: { color: colors.textMuted, fontSize: font.xs, lineHeight: 20 },
  guideLink: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  guideLinkText: { flex: 1, color: colors.accent, fontSize: font.sm, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  label: { color: colors.text, fontSize: font.lg },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.textMuted, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: colors.accent },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  input: { backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderRadius: radius.md, borderWidth: 1, color: colors.text, fontSize: font.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  serverSavedInput: { opacity: 0.5 },
  msg: { color: colors.accent, fontSize: font.md, textAlign: 'center' },
  serverSaved: { color: colors.accent, fontSize: font.sm, textAlign: 'center' },
  version: { color: colors.textFaint, fontSize: font.sm, textAlign: 'center', marginTop: spacing.md },
});
