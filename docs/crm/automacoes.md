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

## Avisos de chegada e rodízio de Formatação (05/10/2026)

- **Lead novo pela Meta, pelo RD (landing) ou pelo formulário do site**, criado (não junção) e fora de importação: `announceNewLead` (`crm-alerts.ts`), chamado por `upsertLead`, direto no código, sem regra cadastrada.
  - **Com dono** (do rodízio): o dono recebe em Avisos "Novo lead para você" com o prazo do primeiro contato (1 hora útil, horário de Brasília).
  - **Sem dono** (rodízio do funil vazio): Diretoria e gerentes do comercial (papel `gerente_comercial` ou gerente de setor do Comercial), só ativos, recebem na hora "Lead sem dono". Vendedores não.
  - O texto nunca cita a pessoa. Um aviso por lead e pessoa (`dedupe_key`); falha ao avisar não desfaz o lead. Importação, espelho do RD CRM, WhatsApp por link e junção com lead existente não geram esse aviso.
- **Migração `0069_crm_rotation_formatacao_diretoria`:** a 0065 só aceitava papéis de vendedor/gerente e deixou o rodízio de Formatação vazio quando a Thais é Diretoria. A 0069 a coloca no rodízio de Formatação **só se o funil não tiver nenhum membro**; quem já está lá não é tocado; se ela não existir, só registra um NOTICE. Consultoria não foi incluída.
- **Ordem de merge:** 0068 é da previsão de fechamento; na junção conferir que o `when` da 0069 no `_journal.json` é maior que o da 0068 (o Drizzle ignora migração com data anterior à última aplicada).
- **Consultoria começa vazia (decisão do Eric):** nenhuma migração a coloca no rodízio. Lead novo de Consultoria sem dono cai na rede de segurança acima (Diretoria e gerentes recebem "Lead sem dono").
- **Backfill (lead já velho quando lido):** lead da Meta com mais de 24 horas desde o `created_time` (`STALE_ARRIVAL_HOURS`, `isStaleArrival` em `service.ts`) entra com dono pelo rodízio, mas **sem tarefa de primeiro contato e sem o aviso de 1 hora útil**. No lugar, **uma leitura gera um aviso por dono** ("N leads antigos da Meta foram atribuídos a você", `announceBackfill`); sem dono (rodízio vazio), **um** aviso com a contagem para a Diretoria, não um por lead. "Uma leitura" = uma passada de `processMetaLeadgenEvents` (a leitura de 5 min, "Buscar agora" ou o webhook). Lead com menos de 24 horas segue o fluxo de chegada.
- **Fica para depois (decisão do Eric):** dar dono aos leads antigos sem dono.

## Migração

`0066_crm_automations` (8 tabelas; renumerar no merge se outra entrar antes). `wings_ro` lê
regras, execuções, sequências e limites de etapa; o outbox e os avisos ficam de fora (têm texto).
