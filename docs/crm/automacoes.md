# CRM Vendas: regras de automação

Formato das "Regras de automação" do Bitrix24: por etapa do funil, o que acontece quando
uma negociação **entra** nela. Tela: `/crm-vendas/configuracoes/automacoes/:pipeline`
(`crm.manage`). API: `/crm/automations/*`.

## Ações

| Ação | O que faz | Serviço usado |
| --- | --- | --- |
| Criar tarefa | tarefa automática (`auto`) para o responsável ou uma pessoa, prazo em horas úteis (seg–sex 9h–18h) ou corridas | `createTask` |
| Mudar o responsável | para uma pessoa ou o próximo do rodízio do funil | `nextInRotation` + `changeLead` |
| Avisar alguém | aviso no painel (`crm_notifications`), texto da regra, sem dado pessoal | — |
| Iniciar sequência | agenda os passos (tarefa, e-mail ou aviso) com intervalo em horas | — |
| Enviar modelo de e-mail | grava no `crm_email_outbox` e na linha do tempo (`lead.email_sent`, só ids) | transporte de CRM |

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

## Alertas de prazo e desvio (só no painel)

Mesmo ciclo, depois das regras (`crm-alerts.ts`). Avisos em `crm_notifications`, tela
`/crm-vendas/avisos`, para o **vendedor, o gerente do setor dele e a Diretoria**:

- **primeiro contato atrasado**: a tarefa `first_contact` passou do prazo (1 hora útil);
- **tarefa atrasada**: qualquer outra tarefa aberta vencida;
- **negociação parada**: mais de N dias na etapa (N por etapa na tela de regras; padrão
  `CRM_STAGE_STUCK_DAYS` = 7; 0 desliga).

Um aviso por condição e pessoa (`dedupe_key`: não repete a cada ciclo; novo prazo = novo aviso).
O texto diz o problema, nunca o nome do lead. Negociação ganha ou perdida não gera aviso.
Sem WhatsApp nem e-mail por enquanto.

## E-mail

`CRM_EMAIL_MODE`: `test` (padrão, grava e não envia nada) ou `smtp` (Workspace, o mesmo
`SMTP_*` das senhas). Variáveis dos modelos: `{{nome}}` (primeiro nome), `{{marca}}`,
`{{vendedor}}`, `{{etapa}}`; qualquer outra é recusada ao salvar. O texto fica no outbox
(a ficha do lead), nunca em log.

**Pela ficha da negociação** (aba E-mail): a pessoa escolhe um modelo ativo, lê a prévia já
preenchida e envia. Só modelos, sem texto livre. `GET /leads/:id/emails` (modelos ativos e o
que já foi registrado), `POST /leads/:id/emails/preview` e `POST /leads/:id/emails`
(`leads.write`, no escopo de quem chama: o vendedor só a ficha dos seus leads, o resto responde
404). Mesmo serviço das regras (`sendTemplateToLead`), mesmo outbox e o mesmo evento
`lead.email_sent`; auditoria `lead.email_sent` / `lead.email_failed` só com ids. Em modo `test`
(o padrão) nada sai: a tela diz "Registrado (modo de teste)". Sem migração.

## Migração

`0066_crm_automations` (8 tabelas; renumerar no merge se outra entrar antes). `wings_ro` lê
regras, execuções, sequências e limites de etapa; o outbox e os avisos ficam de fora (têm texto).
