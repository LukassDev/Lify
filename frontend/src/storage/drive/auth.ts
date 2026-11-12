import { Platform } from 'react-native';
import { DRIVE_SCOPE, GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID } from './config';
import { t } from '@/i18n';

let configured = false;
async function sdk() {
  if (Platform.OS === 'ios' && !GOOGLE_IOS_CLIENT_ID) throw new Error(t('drive.notConfigured'));
  // Lazy import keeps Expo Go usable when the native sign-in module is absent.
  let module: typeof import('@react-native-google-signin/google-signin');
  try { module = await import('@react-native-google-signin/google-signin'); }
  catch { throw new Error(t('drive.nativeBuildRequired')); }
  if (!configured) {
    module.GoogleSignin.configure({
      ...(Platform.OS === 'ios' ? { webClientId: GOOGLE_WEB_CLIENT_ID || undefined, iosClientId: GOOGLE_IOS_CLIENT_ID } : {}),
      scopes: [DRIVE_SCOPE],
    });
    configured = true;
  }
  return module;
}

export function prepareDriveAuth(): void {}

export async function getDriveClientId(): Promise<string> { return GOOGLE_WEB_CLIENT_ID; }
export async function setDriveClientId(_value: string): Promise<void> { /* Android uses package + signing certificate. */ }

export function driveEntryAccessToken(): Promise<string> { return driveAccessToken(); }

export async function driveAccessToken(interactive = false, chooseAccount = false): Promise<string> {
  const { GoogleSignin } = await sdk();
  if (interactive) {
    if (chooseAccount && GoogleSignin.hasPreviousSignIn()) await GoogleSignin.signOut();
    if (Platform.OS === 'android') await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const result = await GoogleSignin.signIn();
    if (result.type !== 'success') throw new Error(t('drive.authCancelled'));
    if (!result.data.scopes.includes(DRIVE_SCOPE)) {
      const granted = await GoogleSignin.addScopes({ scopes: [DRIVE_SCOPE] });
      if (granted?.type !== 'success' || !granted.data.scopes.includes(DRIVE_SCOPE)) throw new Error(t('drive.scopeRequired'));
    }
  } else {
    const result = await GoogleSignin.signInSilently();
    if (result.type !== 'success') throw new Error(t('drive.reauthorize'));
  }
  return (await GoogleSignin.getTokens()).accessToken;
}

export async function disconnectDriveAuth(): Promise<void> {
  const { GoogleSignin } = await sdk();
  await GoogleSignin.signOut();
}

export async function invalidateDriveToken(token: string): Promise<void> {
  const { GoogleSignin } = await sdk();
  await GoogleSignin.clearCachedAccessToken(token);
}
