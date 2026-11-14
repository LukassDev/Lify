# Sincronização automática com um projeto pessoal Supabase

Esta opção sincroniza favoritos, playlists (incluindo ordem e pins), idioma e
preferência de histórico. Não envia áudio, downloads, histórico de músicas
ou estado de reprodução. Não usa conta Google nem o servidor de áudio do Lify.

## 1. Criar e configurar o projeto

1. Entre no [painel Supabase](https://supabase.com/dashboard) e crie um projeto pessoal.
2. Abra **SQL Editor → New query**, cole [supabase-setup.sql](supabase-setup.sql) e execute.
   O mesmo SQL está em **Lify → Ajustes → Sincronização Supabase → Copiar SQL**.
3. O script cria os documentos da biblioteca, a função de envio, políticas por
   utilizador e a publicação Realtime. Pode executá-lo novamente sem apagar dados.
4. No painel, obtenha a **Project URL** e a chave **publishable** em **Connect / API Keys**.
   A chave legada **anon** também é aceite. Não use `secret` nem `service_role`.
5. Em **Authentication → Providers**, mantenha o login **Email** ativo. Se a
   confirmação de email estiver ativa, confirme o email antes de entrar no Lify.
   Não é necessário configurar login Google nem OAuth para esta opção.

Não coloque a senha da base de dados, tokens administrativos ou a senha do painel
Supabase nos campos do Lify. Os campos de ligação recebem apenas URL e chave pública.

## 2. Ligar o primeiro dispositivo

1. Nos Ajustes do Lify, introduza a URL e a chave pública e escolha **Guardar projeto**.
2. Introduza um email e uma palavra-passe e escolha **Criar conta neste projeto**.
3. Confirme o email, se solicitado. Depois escolha **Entrar na conta** no Lify.
4. Ative **Sincronização automática** e confirme a associação à conta e projeto mostrados.

A conta usada no painel Supabase administra o projeto. A conta criada pelo Lify
em Supabase Auth identifica a sua biblioteca. São funções distintas, embora
possa usar o mesmo endereço de email. Não precisa de criar outra conta Supabase
no painel para o segundo dispositivo.

## 3. Ligar o telemóvel e a Web à mesma biblioteca

1. No segundo dispositivo, guarde exatamente a mesma URL e chave pública.
2. Escolha **Entrar na conta** com o mesmo email e palavra-passe criados no Lify
   no primeiro dispositivo. **Não crie uma nova conta de dados.**
3. Ative a sincronização no segundo dispositivo.
4. Marque uma música como favorita no primeiro: deve aparecer no outro enquanto
   ambos estiverem abertos e ligados à Internet, sem botões de subir/puxar.

Na primeira associação, documentos locais que ainda não existam são acrescentados
à nuvem. Para a mesma chave já existente, a versão da nuvem prevalece nessa
associação inicial. Playlists independentes são preservadas; playlists antigas
importadas separadamente em dois dispositivos podem aparecer como duas playlists.
No segundo dispositivo, é preferível receber a biblioteca pela sincronização em
vez de importar uma segunda cópia de um backup antigo.

## Funcionamento e limites

- As alterações entram numa fila SQLite durável e o envio é tentado a cada segundo
  enquanto a app está em execução. O Realtime sinaliza atualizações do outro dispositivo.
- As alterações offline são enviadas ao recuperar a ligação. O Lify também verifica
  alterações ao regressar à app e periodicamente para recuperar eventos perdidos.
- Eliminações são documentos de remoção, para que uma máquina offline não restaure
  acidentalmente favoritos/playlists que já foram eliminados.
- Repetir um envio após uma falha não executa de novo uma operação já aceite pelo servidor.
- Favoritos de músicas diferentes são independentes. Se dois dispositivos editarem
  a **mesma playlist** ou o mesmo favorito offline, prevalece o último envio aceite
  para esse documento. Não há fusão da ordem de uma playlist linha a linha.
- Apps fechadas ou suspensas pelo sistema não mantêm uma ligação Realtime ativa.
  Aguarde a fila chegar a zero antes de fechar se precisar da alteração imediatamente
  disponível no outro dispositivo.
- Desativar a sincronização ou sair interrompe os envios. Alterações locais da
  biblioteca associada continuam na fila para quando ativar novamente com a mesma conta.
- Ao confirmar a associação a uma conta/projeto diferente, a biblioteca local atual
  é associada ao novo destino; operações antigas não são reutilizadas nessa conta.
- A ativação desliga o backup automático do Google Drive. Desative o Supabase antes
  de restaurar um backup completo ou usar os envios/restauros manuais do Drive.
- A URL e chave pública ficam no dispositivo. No Android/iOS, a sessão Auth é
  guardada em SecureStore; na Web, no armazenamento do navegador. A palavra-passe
  não é guardada pelo Lify. Um novo build nativo deve incluir `expo-secure-store`.

As políticas RLS permitem ler apenas documentos cujo `user_id` seja o da sessão.
O envio usa uma função autenticada que obtém esse ID da sessão, sem aceitar um ID
de utilizador fornecido pelo cliente. Nenhuma tabela está aberta para escrita anónima.

## Se não sincronizar

- Confira se os dois dispositivos mostram o mesmo projeto e email.
- Verifique se o SQL foi executado no projeto correto e se a tabela
  `lify_sync_records` está na publicação `supabase_realtime`.
- Confirme o email e entre novamente se a sessão tiver expirado.
- Leia o erro e o número de alterações pendentes nos Ajustes. Uma falha de rede
  conserva as alterações locais e tenta novamente; não precisa de exportar um backup.
- A disponibilidade e os limites do seu plano/projeto Supabase continuam a aplicar-se.

Referências: [Auth React Native](https://supabase.com/docs/guides/auth/quickstarts/react-native),
[Realtime Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes),
[API keys](https://supabase.com/docs/guides/api/api-keys).
