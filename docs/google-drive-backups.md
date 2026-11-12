# Google Drive no Lify

O funcionamento segue o Google Classroom do oStudy: cada utilizador liga a sua
conta Google. Na Web, pode guardar o seu Client ID diretamente nos Ajustes; no
Android, o SDK identifica a aplicação pelo pacote e certificado de assinatura.
O Client ID identifica a aplicação OAuth, não o utilizador. Não há conta Google
partilhada nem Client Secret no Lify.

## Web

1. No Google Cloud Console, ative a **Google Drive API**.
2. Configure o consentimento OAuth com
   `https://www.googleapis.com/auth/drive.appdata`. Em testes, adicione os emails autorizados.
3. Crie um cliente OAuth **Aplicação Web** e registe as origens JavaScript onde
   executa o Lify, incluindo a porta do servidor local e a origem publicada.
4. Nos Ajustes do Lify → Google Drive, cole o Client ID, guarde e ligue a conta.

O Client ID e a sessão são guardados apenas no armazenamento deste navegador,
fora dos backups. Um token ainda válido é reutilizado após refresh. Ao expirar,
o Lify tenta renovar a autorização; se o navegador bloquear a janela Google,
mostra um botão para continuar. Desligar remove a sessão deste navegador.

## Android

Crie um cliente OAuth **Android** no mesmo projeto Google Cloud:

- Pacote: `com.lify.app`.
- SHA-1 fornecido para esta keystore EAS:
  `BC:58:FF:31:6C:E8:A0:DA:A8:37:54:8E:82:83:5E:FF:63:73:99:32`.

Não é necessário colar um Client ID Web no Android. Cada utilizador escolhe a sua
conta no login nativo. É necessário um build que inclua Google Sign-In; Expo Go
não inclui este módulo. Builds debug ou distribuídos pela Google Play podem usar
outro certificado: registe o SHA-1 correspondente à versão instalada.

## Partilhar a biblioteca entre Web e Android

Use a mesma conta Google e clientes OAuth pertencentes ao **mesmo projeto Google
Cloud**. A pasta `appDataFolder` pertence à aplicação: clientes de projetos
distintos não constituem a mesma conta Lify, mesmo usando o mesmo email Google.

Ative **Backup automático no Drive** para sincronizar ao abrir, atualizar ou
regressar à app. Restauros e substituições em conflito exigem confirmação.
Áudios, downloads e configurações de ligação continuam locais.

## iOS

Configure `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` antes de gerar um novo build. O
`app.config.js` regista o esquema de retorno correspondente ao cliente iOS.

Referências: [Google Drive app data](https://developers.google.com/workspace/drive/api/guides/appdata),
[Google Sign-In nativo](https://react-native-google-signin.github.io/docs/original),
[Google Identity Services Web](https://developers.google.com/identity/oauth2/web/guides/use-token-model).
