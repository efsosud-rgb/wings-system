# Google Workspace por pessoa: Agenda, Meet e Gmail

> **Estado em 07/10/2026:** código e testes com um Google simulado (`fake-google.ts`). **Não
> verificado ao vivo**: o cliente OAuth ainda não existe no Cloud da Wings; o primeiro teste real
> (conectar, marcar uma reunião consigo mesmo) é do Eric. O Meet na agenda compartilhada e o envio
> de e-mail pelo Gmail ficam "não verificado" até esse teste.

## O que é

Cada pessoa conecta **a própria conta** Google do Workspace, uma vez, em **Minha conta** (menu do
nome, canto superior direito). A partir daí, com a conta dela:

- **Agendar reunião** na negociação cria o evento no Google Agenda, com Meet gerado, na agenda
  dela (`primary`) ou na agenda **Wings Company** (a agenda principal da Thais,
  `thais@wingscompany.com.br`, já compartilhada com a equipe), do jeito que a equipe escreve as
  calls (ver "Padrão da equipe"). O dono da negociação é avisado; o lead só é convidado por e-mail
  quando a pessoa marca "Convidar o lead" (Formatação) — e nunca numa Expansão com marca.
- **Remarcar** e **Cancelar** no sistema vão primeiro ao Google (os convidados recebem o aviso) e
  só depois mudam a cópia do CRM. Se o Google recusar, a tela oferece "mudar só no sistema".
- **Iniciar reunião** abre o Meet do evento ao lado do Wings.
- Com `CRM_EMAIL_MODE=gmail`, o **e-mail ao lead** (aba E-mail da negociação e as automações)
  sai do endereço dela pelo Gmail (`users.messages.send`), com o nome dela no remetente; a
  resposta do lead chega na caixa dela. Quem não conectou cai no SMTP da empresa (`SMTP_FROM`);
  sem SMTP o envio é recusado e fica registrado como falho. Numa automação o remetente é o dono
  do lead. O outbox guarda `from_email`, `Message-ID`, `gmail_message_id` e `gmail_thread_id`.
  Com anexos (Escrever e-mail, até 20 MB somados), a mensagem vai inteira pelo envio por upload
  (`upload/gmail/v1/users/me/messages/send?uploadType=media`, `message/rfc822`), que aceita até
  35 MB; esse caminho não leva `threadId`. **Não verificado** contra o Gmail real: só contra o
  Google simulado dos testes (`fake-google.ts`). Ver `docs/crm/automacoes.md` (E-mail).
- O módulo **Agenda** (a tela tipo Google Agenda, com a agenda da pessoa e a Wings Company) usa
  esta mesma conexão: ver [docs/agenda.md](../agenda.md).
- (Etapa seguinte) as respostas do lead na linha do tempo: exige o escopo restrito
  `gmail.readonly` e uma leitura periódica (`history.list`) por pessoa conectada.

O token é da pessoa e age só como ela: o sistema nunca cria evento nem manda e-mail em nome de
outra. Quem não conectou continua marcando com o link colado.

## Padrão da equipe na agenda (81 eventos lidos em 07/10/2026)

| | Expansão | Formatação |
| --- | --- | --- |
| Título | `@ <Nome do lead> ( <Marca> ) - CALL` | `@ Formatação ( <Empresa> - <Nome do lead> ) - CALL` |
| Cor | a da agenda (sem `colorId`) | Banana (`colorId` 5) |
| Meet | gerado | gerado |
| Duração | 60 min | 60 min |
| Convidados | nenhum (a equipe não põe o lead) | nenhum por padrão; "Convidar o lead" é opção |
| Descrição | nenhuma | só o aviso de gravação, e só quando o lead é convidado |

O sistema escreve exatamente isso (`meetingTitleOf`, `MEETING_GOOGLE_COLOR` em
`packages/shared/src/meetings.ts`): o título do evento no Google e no CRM vem do padrão, com o nome,
a marca e a empresa do lead. Flamingo (4, trabalho de formatação `FMT | <cliente>`), Tangerina (6,
reuniões internas) e Tomate (11, jurídico e externos) são de outros usos e o sistema nunca as usa.
Lembretes: os padrões da agenda.

## Regra da marca (Eric, 07/10 17:06)

Numa negociação de **Expansão com marca**, o lead não pode ver a Wings. Um convite do Google ou um
e-mail de uma conta `@wingscompany.com.br` mostra a Wings, então nessas negociações
(`leadHidesWings`: funil `expansao` com `brand` preenchida):

- o sistema **não convida o lead** nem aceita convidados de fora (na criação e no remarcar);
- a aba E-mail **não envia** (`409 brand_hidden`), e as automações também não;
- o link do Meet vai pelo **WhatsApp**, no modelo `expansao_lembrete_reuniao`, que não cita a Wings;
- a tela mostra isso no lugar da caixa de convidar.

Na Formatação, "Convidar o lead por e-mail" continua como opção, desmarcada por padrão.

## Qual autorização é — e por que não a delegação de domínio

| | Consentimento de cada pessoa (**escolhido**) | Delegação para todo o domínio |
| --- | --- | --- |
| Quem clica | Eric cria o cliente OAuth uma vez; cada pessoa clica "Conectar" uma vez | Thais (superadmin) autoriza um service account para **todos** |
| O que o sistema pode | Só a agenda e a caixa de quem consentiu | Agir como **qualquer** pessoa do domínio |
| Revisão do Google | Nenhuma: app **Interno** (só contas do Workspace da Wings) não passa por verificação nem mostra "app não verificado", mesmo com escopos sensíveis/restritos | Nenhuma, mas exige chave de service account — que a organização da Wings **bloqueia** (ver `lib/ga4.ts`) |
| Recomendação do Google | É o caminho padrão para apps que agem pelo usuário | "Evite a delegação de domínio quando o fluxo de consentimento resolve" |

Fontes: [configurar a tela de consentimento](https://developers.google.com/workspace/guides/configure-oauth-consent),
[delegação de domínio](https://knowledge.workspace.google.com/admin/apps/control-api-access-with-domain-wide-delegation),
[boas práticas de service accounts](https://docs.cloud.google.com/iam/docs/best-practices-for-using-and-managing-service-accounts).

## Passo a passo do Eric (uma vez, ~30 min)

Tudo em [console.cloud.google.com](https://console.cloud.google.com), logado com a conta da Wings.

1. **Projeto dentro da organização.** No topo, abra o seletor de projeto e confira que o projeto
   aparece **sob a organização `wingscompany.com.br`** (coluna "Organização"). Se o projeto do
   Google Ads for pessoal (sem organização), crie um projeto novo: "Novo projeto" → nome
   `Wings System` → Organização: a da Wings → Criar. Sem organização, o público "Interno" não
   existe e o app ficaria "Em teste": o Google expira o token em **7 dias**.
2. **Ativar as APIs.** Menu ☰ → "APIs e serviços" → "Biblioteca" → procure **Google Calendar
   API** → Ativar; volte e ative **Gmail API**.
3. **Marca do app.** Menu ☰ → "Google Auth platform" → **Branding**: nome `Wings System`, e-mail
   de suporte (o seu), domínio autorizado `wingssystem.online`, e-mail do desenvolvedor → Salvar.
4. **Público Interno.** "Google Auth platform" → **Audience** → Tipo de usuário: **Interno** →
   Salvar. (Aqui é onde se confirma o passo 1: se "Interno" não aparecer, o projeto está fora da
   organização.)
5. **Escopos.** "Google Auth platform" → **Data Access** → "Adicionar ou remover escopos" → cole na
   caixa "Inserir escopos manualmente", um por linha:
   ```
   openid
   https://www.googleapis.com/auth/userinfo.email
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/calendar.calendarlist.readonly
   https://www.googleapis.com/auth/gmail.send
   ```
   → "Adicionar à tabela" → Atualizar → Salvar. (Para a etapa das respostas do lead entra depois
   `gmail.readonly`.)
6. **Cliente OAuth.** "Google Auth platform" → **Clients** → "Criar cliente" → Tipo: **Aplicativo
   da Web** → Nome `Wings System (staging e produção)` → em "URIs de redirecionamento
   autorizados" clique "Adicionar URI" duas vezes:
   ```
   https://staging.wingssystem.online/api/me/google/callback
   https://wingssystem.online/api/me/google/callback
   ```
   → Criar. Copie o **ID do cliente** e a **chave secreta** (só aparece agora; se perder, "Redefinir
   chave secreta").
7. **Coolify.** No terminal do servidor (nunca pelo chat), para **api-staging** primeiro:
   ```
   wings-env set api-staging GOOGLE_WORKSPACE_CLIENT_ID '<id>.apps.googleusercontent.com'
   wings-env set api-staging GOOGLE_WORKSPACE_CLIENT_SECRET '<chave>'
   wings-env set api-staging GOOGLE_WORKSPACE_WINGS_CALENDAR_ID 'thais@wingscompany.com.br'
   ```
   Confira que `INTEGRATIONS_ENCRYPTION_KEY` existe na API (é a mesma chave do Kairogen; se não
   existir em produção, gere com `openssl rand -base64 32` e **não** reutilize a do CPF). Depois
   `wings-deploy staging`. Produção: os mesmos nomes, com `PRODUCAO`.
8. **Teste real** (staging): entre no sistema → menu do nome → **Minha conta** → "Conectar minha
   conta Google" → tela do Google: escolha a conta da Wings → "Continuar" → marque todas as
   permissões → "Continuar" → volta para Minha conta com "Conta Google conectada" e as duas agendas.
   Depois abra uma negociação sua → aba Reunião → Agendar → deixe "Criar o evento e o Meet no Google
   Agenda" marcado → Marcar. Deve aparecer o link do Meet, "Abrir no Google Agenda", e o convite deve
   chegar no e-mail do lead (use um lead com o seu e-mail). Remarque e cancele para ver os avisos.

## A agenda "Wings Company"

É a agenda **principal da Thais** (`thais@wingscompany.com.br`), renomeada "Wings Company", e já
está compartilhada com Fernando, Daniele, Luana e Eric com permissão de criar eventos (todos já
criaram eventos nela). Não há pedido a fazer à Thais; o id vai direto na variável
`GOOGLE_WORKSPACE_WINGS_CALENDAR_ID`. Um vendedor novo precisa ser adicionado por ela em
Configurações e compartilhamento → "Fazer alterações nos eventos"; a tela Minha conta mostra
"só leitura" ou "não compartilhada" quando falta isso.

**Só se o Google bloquear** ao conectar ("o administrador não permite"): em
[admin.google.com](https://admin.google.com) → Segurança → "Controle de acesso e de dados" →
"Controles de API" → "Gerenciar acesso de apps de terceiros" → "Configurar apps internos" →
**"Confiar em apps internos"** → Salvar. Para a Agenda e o `gmail.send` isso normalmente não é
necessário; para a leitura das respostas (`gmail.readonly`, escopo restrito) pode ser. Nada disso é
delegação de domínio.

## Como funciona por dentro

- Rotas `GET /me/google`, `POST /me/google/connect`, `GET /me/google/callback`, `DELETE
  /me/google` (`modules/google-workspace/routes.ts`), só da própria sessão.
- Tabela `google_workspace_connections` (migração 0078): uma linha por funcionário; `access_token_enc`,
  `refresh_token_enc` e o verificador PKCE em `pending` cifrados com `INTEGRATIONS_ENCRYPTION_KEY`
  (`lib/secret-box.ts`); `google_email` é a conta que consentiu; `last_error` é só um código. O
  papel `wings_ro` não lê esta tabela.
- Fluxo: PKCE S256 + `state` (15 min), `access_type=offline` + `prompt=consent` para o Google
  entregar o refresh token; sem refresh token a conexão é recusada (`no_refresh_token`). O refresh
  acontece sob `SELECT … FOR UPDATE`, 60 s antes de vencer; `invalid_grant` marca
  `needs_reconnect`. Desconectar revoga em `oauth2.googleapis.com/revoke` e apaga a linha.
- Google Agenda por `fetch` (`calendar.ts`), sem biblioteca: `calendarList.list` (agendas e
  `accessRole`), `events.insert` com `conferenceDataVersion=1`, `sendUpdates=all` e
  `conferenceData.createRequest{hangoutsMeet}`, `events.get` enquanto o Meet está `pending`,
  `events.patch`, `events.delete`. Fuso dos eventos: `America/Sao_Paulo`.
- Reuniões: `modules/meetings/google-sync.ts` (quem é convidado, qual token, o que vira 503/409/502)
  e `docs/crm/reunioes-api.md`.
- Nada de pessoal nos logs: e-mails dos convidados ficam só em `crm_meetings.attendees`.

## Variáveis

| Nome | Onde | O que é |
| --- | --- | --- |
| `GOOGLE_WORKSPACE_CLIENT_ID` | api | ID do cliente OAuth "Aplicativo da Web" (passo 6) |
| `GOOGLE_WORKSPACE_CLIENT_SECRET` | api | Chave secreta do mesmo cliente |
| `GOOGLE_WORKSPACE_WINGS_CALENDAR_ID` | api | `thais@wingscompany.com.br` (a agenda "Wings Company") |
| `INTEGRATIONS_ENCRYPTION_KEY` | api | Já existe (Kairogen); cifra os tokens |
| `CRM_EMAIL_MODE` | api | `gmail` liga o envio pelo Gmail de cada pessoa (com `smtp` de reserva); `test` até os modelos serem aprovados |
| `APP_BASE_URL` | api | Já existe; monta a URI de redirecionamento |

## Limites conhecidos

- Numa Expansão com marca o lembrete pelo WhatsApp (`expansao_lembrete_reuniao`) ainda é um clique
  da pessoa na tela do WhatsApp; o sistema não o dispara sozinho ao marcar.
- Resposta dos convidados (`responseStatus`) é a do momento da criação; não há leitura periódica
  do Google (um `events.get` ao abrir a reunião pode vir numa etapa seguinte).
- Um evento movido ou apagado **no Google** não volta ao CRM (sem `watch`); o CRM é a cópia.
- Quem criou o evento e saiu da empresa: Remarcar/Cancelar usam o token de quem está mudando, o que
  só funciona na agenda Wings Company (na agenda pessoal do ex-funcionário o Google recusa → "mudar
  só no sistema").
- Importar a gravação do Meet pelo Drive continua 503 (precisaria de `drive.readonly`).
