# CRM Vendas: regras de automação

Formato das "Regras de automação" do Bitrix24: por etapa do funil, o que acontece quando
uma negociação **entra** nela. Tela: `/crm-vendas/configuracoes/automacoes/:pipeline`
(`crm.manage`). API: `/crm/automations/*`.

## Ações

| Ação                    | O que faz                                                                                                      | Serviço usado                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Criar tarefa            | tarefa automática (`auto`) para o responsável ou uma pessoa, prazo em horas úteis (seg–sex 9h–18h) ou corridas | `createTask`                    |
| Mudar o responsável     | para uma pessoa ou o próximo do rodízio do funil                                                               | `nextInRotation` + `changeLead` |
| Avisar alguém           | aviso no painel (`crm_notifications`), texto da regra, sem dado pessoal                                        | —                               |
| Iniciar sequência       | agenda os passos (tarefa, e-mail ou aviso) com intervalo em horas                                              | —                               |
| Enviar modelo de e-mail | grava no `crm_email_outbox` e na linha do tempo (`lead.email_sent`, só ids)                                    | transporte de CRM               |

Cada regra pode ter atraso (minutos, horas ou dias após a entrada).

## Quando dispara

- Só em mudança de etapa feita por **pessoa ou Sofia** (`source` `wings`/`sofia`). O espelho do
  RD e a importação não disparam (inundariam a fila).
- Os `crm_automation_runs` pendentes de uma etapa são **cancelados** quando a negociação sai
  dela ou é ganha/perdida. Uma entrada repetida não duplica (`dedupe_key`).
- Um lead que **nasce** numa etapa dispara as regras dela (exceto importação e espelho do RD).
  Uma regra de tarefa não cria outra igual se já houver uma aberta do mesmo tipo e título
  (o núcleo já faz a de primeiro contato com prazo de 1 hora útil).
- O que está vencido roda na hora; o atrasado (e os passos de sequência) roda no **ciclo do
  processo da API**, a cada `CRM_AUTOMATIONS_CRON` (`*/N * * * *`, 5 minutos por padrão), um ciclo
  por vez (trava de banco entre réplicas). Nada é agendado no Coolify. `POST /crm/automations/run`
  roda o mesmo ciclo à mão.
- Um passo que falha fica `failed` e nunca é repetido sozinho; um processador interrompido
  deixa `running` que vira `failed (interrupted)` depois de 15 minutos.

## Alertas de prazo e desvio (no painel e no sino)

Mesmo ciclo, depois das regras (`crm-alerts.ts`). Avisos em `crm_notifications`, tela
`/crm-vendas/avisos` e sino da barra de cima (avisos não lidos, antes das tarefas do dia). A
**tarefa atrasada** e a **negociação parada** vão para o **vendedor, o gerente do setor dele e a
Diretoria**; o primeiro contato sobe em dois passos (abaixo).

- **primeiro contato atrasado**: ver "Primeiro contato em dois passos";
- **tarefa atrasada**: qualquer outra tarefa aberta vencida;
- **negociação parada**: mais de N dias na etapa (N por etapa na tela de regras; padrão
  `CRM_STAGE_STUCK_DAYS` = 7; 0 desliga).

Um aviso por condição e pessoa (`dedupe_key`: não repete a cada ciclo; novo prazo = novo aviso,
exceto no primeiro contato). O texto diz o problema, nunca o nome do lead. Negociação ganha ou
perdida não gera aviso. Sem WhatsApp. Por e-mail, só o que está em `docs/crm/avisos-por-email.md`
(desligado até o Eric ligar).

### Primeiro contato em dois passos (Eric, 13/10/2026)

A regra é uma só (`firstContactOverdueSql`, em `crm.ts`) e vale para o aviso, para o número e para a
lista: negociação **aberta**, ainda na **etapa de entrada** do funil ("Sem contato" na Formatação,
"Novo Contato" na Expansão, "Novo contato" na Consultoria), com a tarefa `first_contact` **aberta e
vencida** (1 hora útil: seg–sex 9h–18h de São Paulo; não há calendário de feriados, só fins de
semana), entre as que contam desde `CRM_TRACKING_START`. Tirar a negociação da etapa de entrada,
concluir a tarefa, ganhar ou perder encerra a condição.

1. **Passou da 1 hora útil**: aviso `first_contact_overdue` ao **vendedor dono**.
2. **Continua sem contato no fim do dia útil** (18h do dia do prazo; prazo às 18h em ponto ou fora
   do expediente fecha no dia útil seguinte, `endOfBusinessDay` em `packages/shared`): aviso
   `first_contact_escalated` ao **gerente do setor** do vendedor (papel que vê todos os leads com a
   marca de gerente de setor) **e à Diretoria**, como já recebiam; o texto cita a etapa e o primeiro
   nome do vendedor.

Um aviso por **negociação, etapa e pessoa** (`first_contact:<passo>:<lead>:<etapa>:<pessoa>`): mudar o
prazo da tarefa não avisa de novo. Quem já recebeu o aviso antigo por tarefa (chave
`first_contact_overdue:…`) não recebe outro. Em **Negociações**, o contador "N 1º contato atrasado"
abre a lista dessas negociações (`GET /leads?firstContactOverdue=1`, mesmo conjunto do número);
`GET /leads/board/counters` traz `firstContactOverdue`. O log do ciclo traz só contagens
(`firstContact: { overdue, escalated }`).

### Lembrete de reunião (Eric, 19/10)

No mesmo ciclo, cada reunião `agendada` que começa nos próximos 30 minutos (`MEETING_REMINDER_MS` em
`crm-alerts.ts`) deixa um aviso `meeting_soon` no sino do **dono da negociação** e de **quem marcou**
(só pessoas ativas): "Reunião às 14:30", sem o título (que cita o lead); o aviso abre a negociação.
Chave `meeting_soon:<reunião>:<início>:<pessoa>`: remarcar dá um lembrete novo; cancelada ou já
iniciada não avisa. Sem e-mail (`email_state = none`).

## E-mail

`CRM_EMAIL_MODE`: `test` (padrão, grava e não envia nada), `smtp` (remetente da empresa, o mesmo
`SMTP_*` das senhas) ou `gmail` (sai do **Gmail de quem envia** — o vendedor que clicou, ou o
dono do lead numa automação — pela conexão Google de cada pessoa em Minha conta
(`docs/integracoes/google-workspace.md`); quem não conectou cai no SMTP da empresa, e sem SMTP o
envio é recusado e fica `failed`). O outbox guarda `from_email`, o `Message-ID` e, no Gmail, o
id da mensagem e da conversa (`gmail_thread_id`), para a leitura das respostas numa etapa seguinte.
**Expansão com marca** (`leadHidesWings`): nenhum e-mail sai para o lead, pela ficha
(`409 brand_hidden`) nem por automação (`reason: brand_hidden`, sem linha no outbox) — o lead não
pode ver a Wings; o contato é pelo WhatsApp em nome da marca. **Não me contate por e-mail**
([nao-me-contate.md](nao-me-contate.md)): nada sai, pela ficha (`409 contact_blocked`, com o
motivo) nem por regra ou sequência (`reason: contact_blocked`, sem linha no outbox), e a linha do
tempo ganha `lead.contact_blocked`. Variáveis dos modelos: `{{nome}}` (primeiro nome), `{{marca}}`,
`{{vendedor}}`, `{{etapa}}`; qualquer outra é recusada ao salvar. O texto fica no outbox
(a ficha do lead), nunca em log.

**Pela ficha da negociação** (aba E-mail): a pessoa escolhe um modelo ativo, lê a prévia já
preenchida e envia. Só modelos, sem texto livre. `GET /leads/:id/emails` (modelos ativos e o
que já foi registrado), `POST /leads/:id/emails/preview` e `POST /leads/:id/emails`
(`leads.write`, no escopo de quem chama: o vendedor só a ficha dos seus leads, o resto responde
404). Mesmo serviço das regras (`sendTemplateToLead`), mesmo outbox e o mesmo evento
`lead.email_sent`; auditoria `lead.email_sent` / `lead.email_failed` só com ids. Em modo `test`
(o padrão) nada sai: a tela diz "Registrado (modo de teste)". Sem migração.

## Avisos de chegada e rodízio de Formatação (05/10/2026)

- **Lead novo pela Meta, pelo RD (landing) ou pelo formulário do site**, criado (não junção) e fora de importação: `announceNewLead` (`crm-alerts.ts`), chamado por `upsertLead`, direto no código, sem regra cadastrada.
  - **Com dono** (do rodízio): o dono recebe em Avisos "Novo lead para você" com o prazo do primeiro contato (1 hora útil, horário de Brasília).
  - **Sem dono** (rodízio do funil vazio): Admin Master, Diretoria e gerentes do comercial (papel `gerente_comercial` ou gerente de setor do Comercial), só ativos, recebem na hora "Lead sem dono". Vendedores não.
  - O texto nunca cita a pessoa. Um aviso por lead e pessoa (`dedupe_key`); falha ao avisar não desfaz o lead. Importação, espelho do RD CRM, WhatsApp por link e junção com lead existente não geram esse aviso.
- **Migrações do rodízio de Formatação:** a `0069_crm_rotation_formatacao_diretoria` (já rodou no staging) pôs a Thais, que é Diretoria, quando o funil estava vazio; não se edita. A `0070_crm_rotation_formatacao_vendedoras` (decisão do Eric, 05/10: só a vendedora nova, a Daniela) deixa no rodízio de Formatação **só as pessoas ativas com papel `vendedor_formatacao`**: tira quem não tem o papel ou está inativo (os leads dessa pessoa ficam com ela), inclui quem tem e ainda não está, e mantém a pausa de quem já estava. Idempotente; sem ninguém com o papel o rodízio fica vazio e a rede de segurança avisa; registra um NOTICE com as contagens. Não toca Expansão nem Consultoria. O acesso da Daniela como Vendedor Formatação precisa existir antes da migração; se vier depois, é pela tela do rodízio.
- **Ordem das migrações:** a 0069 vem depois da 0068 (previsão de fechamento) no `_journal.json`, com `when` maior.
- **Consultoria começa vazia (decisão do Eric):** nenhuma migração a coloca no rodízio. Lead novo de Consultoria sem dono cai na rede de segurança acima (Diretoria e gerentes recebem "Lead sem dono").
- **Backfill (lead já velho quando lido):** lead da Meta com mais de 24 horas desde o `created_time` (`STALE_ARRIVAL_HOURS`, `isStaleArrival` em `service.ts`) entra com dono pelo rodízio, mas **sem tarefa de primeiro contato e sem o aviso de 1 hora útil**. No lugar, **uma leitura gera um aviso por dono** ("N leads antigos da Meta foram atribuídos a você", `announceBackfill`); sem dono (rodízio vazio), **um** aviso com a contagem para a Diretoria e o Admin Master, não um por lead. "Uma leitura" = uma passada de `processMetaLeadgenEvents` (a leitura de 5 min, "Buscar agora" ou o webhook). Lead com menos de 24 horas segue o fluxo de chegada.
- **Fica para depois (decisão do Eric):** dar dono aos leads antigos sem dono.

## Migração

`0066_crm_automations` (8 tabelas; renumerar no merge se outra entrar antes). `wings_ro` lê
regras, execuções, sequências e limites de etapa; o outbox e os avisos ficam de fora (têm texto).
