# Reuniões: contrato da API

Contrato entre a API (Opus) e a tela da ficha (Fable). Os tipos ficam em
`packages/shared/src/meetings.ts`; este documento diz o que cada rota faz, quem pode e o que
volta. Tudo sob `/api`, mesma origem, sessão por cookie. Respostas de erro no padrão do sistema:
`{ error, message }`.

> **Estado em 07/10/2026:** o evento, o Meet e os convites são criados no Google Agenda com a
> conta de **cada pessoa** (`docs/integracoes/google-workspace.md`): quem conectou a conta em
> Minha conta cria pelo Google; quem não conectou marca com o link colado e recebe **503**. A
> importação da gravação pelo Drive continua 503. **Não verificado ao vivo**: o Meet na agenda
> compartilhada e o convite real esperam o teste do Eric.

## O que é uma reunião

Uma reunião pertence a **uma negociação** (`leadId`) e a **um dono** (o vendedor que marca). Ela
passa por quatro trilhas independentes, cada uma com o seu estado:

| Trilha                            | Estados                                                                | Quem move                                                     |
| --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| Agenda (`status`)                 | `agendada` → `em_andamento` → `encerrada`; ou `cancelada`              | a pessoa (marcar, remarcar, cancelar); o horário (início/fim) |
| Gravação (`recording.state`)      | `nenhuma` → `enviando` → `guardada`; `falhou`                          | upload pela tela; ou import do Google Drive (depois da Thais) |
| Transcrição (`transcript.state`)  | `nenhuma` → `na_fila` → `transcrevendo` → `pronta`; `falhou`           | o worker (Whisper no nosso servidor)                          |
| Análise por IA (`analysis.state`) | `nenhuma` → `na_fila` → `analisando` → `pronta`; `falhou`; `sem_verba` | o pedido da pessoa ou o fim da transcrição                    |

Nos leads de **Expansão** há uma quinta trilha: o **envio do resumo ao dono da franqueadora**
(`summarySend.state`: `nenhum` → `rascunho` → `aprovado` → `enviando` → `enviado`; `recusado`; `falhou`).
**Nada sai sem aprovação de uma pessoa** com `meetings.approve_send`.

## Permissões

- Ver reuniões: `leads.read`, com o mesmo escopo da negociação (próprio, setor, todos). Quem não
  vê a negociação recebe **404** na reunião.
- Marcar, remarcar, cancelar, enviar gravação, pedir análise, nomear falantes, criar tarefa de um
  próximo passo, preparar o rascunho do envio: `leads.write` (mesmo escopo).
- Aprovar e mandar o resumo à franqueadora: **`meetings.approve_send`** (nova; Admin Master,
  Diretoria e Gerente Comercial). Quem aprovou fica gravado; o vendedor não aprova o próprio
  rascunho se não tiver a permissão.

## Rotas

### Agenda

`GET /leads/:id/meetings` → `{ meetings: MeetingSummary[] }`, mais recentes primeiro.

`POST /leads/:id/meetings` → `201 { meeting: Meeting }`

```json
{
  "title": "Diagnóstico com a Empresa Exemplo",
  "startsAt": "2026-10-08T14:00:00-03:00",
  "endsAt": "2026-10-08T15:00:00-03:00",
  "calendar": "vendedor",
  "attendees": [{ "email": "pessoa@exemplo.com.br", "name": "Pessoa" }],
  "meetUrl": null,
  "createMeet": true
}
```

- `calendar`: `vendedor` (a agenda `primary` de quem marca) ou `wings` (a agenda compartilhada
  "Wings Company", id em `GOOGLE_WORKSPACE_WINGS_CALENDAR_ID`).
- `createMeet: true` cria o evento no Google Agenda **com a conta de quem marca**
  (`POST calendars/{id}/events?conferenceDataVersion=1&sendUpdates=all`, `createRequest`
  `hangoutsMeet`), espera o Meet ficar pronto (relê até 3 vezes). Título e cor seguem o padrão da
  equipe (`meetingTitleOf`, `MEETING_GOOGLE_COLOR`) e substituem o `title` do corpo. Convidados: o
  dono da negociação, quem marcou (na agenda da Wings), os `attendees` do corpo e o lead só com
  `inviteLead: true` — nunca o lead nem endereços de fora numa Expansão com marca
  (`leadHidesWings`; a regra da marca em `docs/integracoes/google-workspace.md`). Descrição só o
  aviso de gravação, e só quando o lead é convidado. Guarda `googleEventId`, `googleCalendarId`,
  `googleHtmlLink` e os convidados como o Google devolveu (`responseStatus` `sem_resposta`).
  - **503 `google_not_configured`** (sem cliente OAuth no sistema), **503 `google_not_connected`**
    (a pessoa não conectou), **503 `google_needs_reconnect`** (o Google recusou o refresh): a
    tela oferece "colar o link do Meet" (`createMeet: false`, `meetUrl`).
  - **409 `wings_calendar_unavailable`** (id não configurado) e **409 `wings_calendar_forbidden`**
    (a agenda não foi compartilhada com a pessoa como "Fazer alterações nos eventos").
  - **502 `meet_failed`**: o Google criou o evento sem Meet; o evento é apagado e nada é gravado.
- `startsAt` < `endsAt`, no máximo 8 horas; até 20 participantes. Fuso `America/Sao_Paulo`.
- Grava `lead_events` `meeting.scheduled` (sem e-mail de ninguém no detalhe; `google: true|false`).

`GET /meetings/:id` → `{ meeting: Meeting }` (tudo: agenda, gravação, transcrição, análise,
envio).

`PATCH /meetings/:id` → `{ meeting }`. Aceita `title`, `startsAt`, `endsAt`, `attendees`,
`meetUrl`, `status: "cancelada"`, `skipGoogle`. Quando a reunião tem `googleEventId`, o Google
vem **primeiro**: remarcar é `PATCH .../events/{id}?sendUpdates=all`, cancelar é `DELETE` (um
evento já apagado lá conta como cancelado); só depois a cópia do CRM muda. Token usado: o de quem
criou o evento; se essa pessoa não está mais conectada, o de quem está mudando. Se o Google
recusar: **502 `google_sync_failed`** (ou 503/409 acima), a cópia do CRM fica como estava e
`googleSync` vira `falhou` com o código; a tela oferece "Mudar só no sistema" (`skipGoogle:
true`, que grava `googleSync.error = skipped`). Uma reunião encerrada não volta a agendada.

### Abrir o Meet ao lado do Wings

Sem rota nova: a tela abre `meeting.meetUrl` numa janela própria (`window.open(url, 'wings-meet',
'popup,width=…,height=…')`) posicionada ao lado da ficha, que continua aberta com a negociação.
Uma segunda fase pode trocar a janela por um painel do Wings dentro do Meet (complemento do
Google Meet), que também depende da Thais.

### Gravação

`POST /meetings/:id/recording/upload-url` → `{ uploadUrl, headers, fileId, expiresAt }` (o navegador manda o arquivo com `PUT` e exatamente esses cabeçalhos)

```json
{ "contentType": "audio/webm", "sizeBytes": 48211234 }
```

- Mesmo padrão do Drive: endereço assinado para **um tipo e um tamanho exatos**, válido por 15
  minutos; o navegador manda direto para o armazenamento.
- Tipos: `audio/webm`, `audio/ogg`, `audio/mpeg`, `audio/mp4`, `audio/wav`, `video/webm`,
  `video/mp4`. Até 1,5 GB (cerca de 3 horas de vídeo do Meet).
- Reunião que já tem gravação: `409 recording_exists`, salvo quando a transcrição falhou (ou o job
  foi abandonado); aí uma gravação nova substitui a anterior, que é apagada do armazenamento.
- `complete` repetido (clique duplo, nova tentativa do navegador) põe **um** job na fila só.
- Fica na área de gravações do armazenamento do sistema, com chave escolhida pelo servidor (o id
  da reunião e o da gravação, nunca um nome de pessoa); a chave nunca aparece numa resposta. Fora
  das pastas do Drive nesta fase; mostrar também no Drive do Comercial é uma decisão para depois.
- Para ouvir: `GET /meetings/:id/recording/link` → `{ url, expiresAt }`, endereço assinado de 5
  minutos, só para quem vê a negociação.

`POST /meetings/:id/recording/complete` → `202 { meeting }` com `{ fileId }`: o servidor confere
que o arquivo chegou com o tamanho combinado, marca `guardada` e põe a transcrição na fila.

`POST /meetings/:id/recording/import` → `202` (Google Drive, depois da Thais): pega a gravação
que o Meet salvou no Drive do organizador. Hoje: **503 `google_not_connected`**.

### Transcrição

Feita pelo worker (`transcribe_meeting`), com **faster-whisper no nosso servidor** (o mesmo das
legendas do Studio), em português, com tempos por trecho. A **separação de quem falou** é um
passo à parte depois do Whisper: os trechos ganham `speaker` `"S1"`, `"S2"`…; até ele existir,
`speaker` vem `null` e `transcript.speakersReason` diz por quê.

`GET /meetings/:id/transcript` → `{ transcript: MeetingTranscript }`

```json
{
  "state": "pronta",
  "language": "pt",
  "durationSeconds": 2715,
  "speakers": [
    { "key": "S1", "label": "Vendedor", "employeeId": "…", "attendeeEmail": null },
    { "key": "S2", "label": null, "employeeId": null, "attendeeEmail": null }
  ],
  "speakersReason": null,
  "segments": [{ "start": 0.0, "end": 4.2, "speaker": "S1", "text": "Bom dia…" }]
}
```

`PATCH /meetings/:id/speakers` → `{ transcript }`: a pessoa diz quem é cada voz
(`{ "S1": { "employeeId": "…" }, "S2": { "attendeeEmail": "…", "label": "Cliente" } }`). A IA
não adivinha nomes para gravar: ela só sugere na análise.

### Análise por IA

`POST /meetings/:id/analysis` → `202 { meeting }`. Também roda sozinha quando a transcrição fica
pronta. Usa o modelo do sistema (OpenRouter, `AGENT_MODEL`) com **teto diário próprio**
(`MEETINGS_DAILY_USD`); passou do teto: `analysis.state = "sem_verba"` e nenhuma chamada. O texto
vai sem telefone, e-mail ou CPF (o mesmo filtro do agente, e mais qualquer sequência de 8 ou mais
dígitos, como o whisper escreve números ditos). Uma análise interrompida por reinício da API
(todo deploy) volta à fila depois de 15 minutos.

`analysis` (quando `pronta`):

```json
{
  "summary": "Texto curto do que foi conversado",
  "topics": ["Faturamento", "Prazo de abertura"],
  "participants": [{ "speaker": "S2", "role": "cliente", "suggestedName": "Pessoa" }],
  "nextSteps": [
    { "what": "Enviar proposta", "owner": "vendedor", "dueAt": "2026-10-10", "taskId": null }
  ],
  "leadEvaluation": {
    "score": 72,
    "fit": "bom",
    "reasons": ["Tem capital declarado", "Quer abrir em 3 meses"],
    "risks": ["Ainda não falou com o sócio"]
  },
  "model": "anthropic/claude-sonnet-5",
  "costUsd": 0.0123,
  "analyzedAt": "2026-10-08T15:20:00Z"
}
```

- A avaliação **não muda nada sozinha**: não move etapa, não muda valor, não cria tarefa.
- `POST /meetings/:id/next-steps/:index/task` → `201 { task }`: um clique da pessoa transforma um
  próximo passo em tarefa da negociação (tipo `follow_up`, prazo sugerido editável).

### Expansão: o resumo para o dono da franqueadora

Só em negociações do funil **Expansão** com marca (`leads.client_id` de uma franqueadora). O
destinatário é o contato **principal** da ficha do cliente (`client_contacts`, papel
`principal`); sem ele: **409 `no_franchisor_contact`**.

1. `POST /meetings/:id/summary-send` → `201`: rascunho (`rascunho`) com texto gerado a partir da
   análise, sem dados do candidato além do primeiro nome, canal `email` ou `whatsapp`.
2. `PATCH /meetings/:id/summary-send` → edição do texto (só em `rascunho`).
3. `POST /meetings/:id/summary-send/approve` (`meetings.approve_send`) com
   `{ "text": "<o texto exato que a pessoa leu>" }` → `aprovado`, com quem e quando. Texto
   diferente do rascunho atual: `409 draft_changed` (alguém editou depois da leitura). A aprovação
   vale para o contato da marca daquele momento (guardado só como hash).
4. `POST /meetings/:id/summary-send/send` (`meetings.approve_send`) → manda **uma vez**, só se
   `aprovado`; falhou: `falhou`, sem nova tentativa automática. Se o contato principal da marca
   mudou desde a aprovação: `409 contact_changed`, volta a `rascunho` e precisa de nova
   aprovação. Grava auditoria `meeting.summary_sent` sem o texto.
5. `POST /meetings/:id/summary-send/refuse` → `recusado`.

### Google, por pessoa (`apps/api/src/modules/google-workspace/`)

- `GET /me/google` → `{ status: GoogleWorkspaceStatus }` da própria sessão: `configured`,
  `state` (`disconnected | pending | connected | needs_reconnect`), `email`, `scopes`,
  `calendars.mine` e `calendars.wings` (`access: writer | reader | none`, lido ao vivo em
  `calendarList`), `wingsCalendarConfigured`, `lastError` (código).
- `POST /me/google/connect` → `{ url }` da tela de consentimento (PKCE S256 + `state`,
  `access_type=offline`, `prompt=consent`); `GET /me/google/callback?code&state` troca o código,
  grava os tokens **cifrados** (`INTEGRATIONS_ENCRYPTION_KEY`) em `google_workspace_connections`
  (uma linha por funcionário, migração 0078) e redireciona para `/minha-conta?google=ok|erro`.
  `DELETE /me/google` revoga e apaga. Tokens nunca vão ao navegador, a um modelo nem a um log; o
  refresh acontece sob trava de linha, 60 s antes de vencer; `invalid_grant` → `needs_reconnect`.
- Escopos: `openid email`, `calendar.events`, `calendar.calendarlist.readonly`, `gmail.send`.
  Autorização = consentimento de cada pessoa num app **Interno** do Cloud da Wings (sem
  delegação de domínio). Passo a passo: `docs/integracoes/google-workspace.md`.

## Tipos (resumo; a fonte é `packages/shared/src/meetings.ts`)

- `MeetingSummary`: `id`, `leadId`, `title`, `startsAt`, `endsAt`, `status`, `calendar`,
  `meetUrl`, `ownerEmployeeId`, `recordingState`, `transcriptState`, `analysisState`,
  `summarySendState`.
- `Meeting`: o resumo (que inclui `googleEventId`) + `attendees` (`{ email, name, responseStatus }`),
  `googleHtmlLink`, `googleSync` (`{ state: ok | falhou, error, at }` ou null),
  `recording` (`state`, `fileId`, `durationSeconds`, `sizeBytes`), `transcript` (estado e
  contagem; o texto vem em `/transcript`), `analysis`, `summarySend` (`state`, `channel`, `to`
  mascarado, `text`, `approvedBy`, `approvedAt`, `sentAt`), `createdAt`, `updatedAt`.

## Dados pessoais e guarda

- Áudio, transcrição e e-mails de participantes são dados pessoais: aparecem só na ficha, para
  quem vê a negociação; **nunca** em log, evento ou auditoria (só ids, estados e números).
- Aviso de gravação: o convite e a tela dizem que a reunião é gravada; o Meet também avisa.
- Guarda proposta (decisão do Eric): áudio por 90 dias, transcrição e análise enquanto a
  negociação existir.

## Para a tela da ficha (Fable)

Aba **Reunião** da ficha: lista (`GET /leads/:id/meetings`), "Marcar reunião" (com fallback de
colar link quando vier 503 `google_not_connected`), detalhe com "Abrir o Meet ao lado", envio da
gravação, transcrição com falantes nomeáveis, análise com "virar tarefa" por próximo passo e, em
Expansão, o cartão do envio ao franqueador com os botões conforme a permissão. Sem dado em
qualquer campo: "—" e o motivo.

## O que já está construído (06/10, `feat/reunioes`)

- **API** (`apps/api/src/modules/meetings/`): todas as rotas acima. As do Google respondem 503
  `google_not_connected`; marcar com link colado, gravação, transcrição, falantes, análise,
  "virar tarefa" e o envio ao franqueador funcionam.
- **Worker**: job `transcribe_meeting` (faster-whisper "small", português), conferido contra um
  banco descartável. Grava a transcrição na reunião e põe a análise na fila; a API pega a fila a
  cada minuto (o modelo e o teto ficam na API). **No staging, `WORKER_JOB_TYPES` precisa incluir
  `transcribe_meeting`.**
- **Teto**: `MEETINGS_DAILY_USD` (padrão 1). Cada chamada reserva US$ 0,25 sob uma trava antes de
  ir ao modelo (tabela `crm_meeting_analysis_runs`, uma linha por chamada) e depois fica com o
  custo real; reanálises e falhas contam, e uma chamada que deu erro fica com a reserva.
- **Migração `0073_crm_meetings`** (tabelas `crm_meetings` e `crm_meeting_analysis_runs`).
  `wings_ro` lê a view `crm_meetings_analysis` (estados, horários, tamanhos, custo e ids, sem dado
  pessoal) e `crm_meeting_analysis_runs`; nunca a tabela `crm_meetings`.
- **Separação de quem falou: não ligada.** Faltam a escolha do motor (pyannote, que pede token do
  Hugging Face e cerca de 2 GB, ou SpeechBrain com agrupamento) e um teste com áudio real de
  reunião. Até lá, `speaker: null` com o motivo, e a tela permite nomear as vozes quando houver.
- **Depende da Thais:** autorizar o app no Admin do Google Workspace (agenda, Meet e importação
  de gravações do Drive) e a conta de serviço ou OAuth por pessoa.
