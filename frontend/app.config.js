const { expo } = require('./app.json');
const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '';
const iosUrlScheme = googleIosClientId.endsWith('.apps.googleusercontent.com')
  ? `com.googleusercontent.apps.${googleIosClientId.replace('.apps.googleusercontent.com', '')}` : '';

module.exports = {
  ...expo,
  extra: {
    ...expo.extra,
    googleWebClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || '',
    googleIosClientId,
  },
  // Android autolinks the SDK. iOS additionally needs the reversed OAuth URL scheme.
  plugins: [...expo.plugins, ...(iosUrlScheme ? [['@react-native-google-signin/google-signin', { iosUrlScheme }]] : [])],
};
