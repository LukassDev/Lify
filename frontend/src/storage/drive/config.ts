import Constants from 'expo-constants';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const GOOGLE_WEB_CLIENT_ID = (Constants.expoConfig?.extra?.googleWebClientId as string | undefined) ?? '';
export const GOOGLE_IOS_CLIENT_ID = (Constants.expoConfig?.extra?.googleIosClientId as string | undefined) ?? '';
