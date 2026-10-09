# CRM Vendas — o Funil como lugar de trabalho (Fase 1)

05/10/2026, branch `feat/crm-trabalho`, migração **0064** (uma só, Lead Ads + Fase 1, renumerada depois da 0063 do Opus; a 0060 é do BI). Decisão do Eric: o Wings System é o CRM oficial; o RD Station CRM recebe cópia durante a transição. O que existia (`fase1-operacao.md`: importador, seguimento por hora, webhook, formulário do site, links) continua valendo; este documento diz o que mudou.

## Etapas (`crm_stages`)

- Uma lista por funil (Expansão, Formatação), com posição, ativa/desativada, `rd_stage_id` (a etapa do RD que ela espelha, quando se sabe) e `sofia_entry` (Fase 4, falsa até a Sofia).
- **Padrão: as etapas do RD**, aprendidas pelo importador e pelo seguimento por hora (`ensureStage`, pelo nome e ordem do RD) e pela migração (a partir dos leads já espelhados). Nada é inventado; "Novo Contato" (Expansão) e "Sem contato" (Formatação) são garantidas como etapa de entrada, porque o Lead Ads e o formulário do site precisam delas.
- Administração → CRM (`crm.manage`: Admin Master e Gerente Comercial): criar, renomear (muda o nome em todos os leads), subir/descer (`PUT /crm/stages/order`, cada etapa ativa uma vez) e desativar (os leads ficam onde estão; a etapa some das opções).

## O lead no funil (`PATCH /leads/:id`)

- Um pedido, várias coisas: `stageId`, `pipeline`, `ownerEmployeeId` (ou `null`), `won` (`true` ganho, `false` perdido com `lostReason`, `null` reabre).
- Permissões: `leads.write` no escopo do papel (vendedor só nos próprios leads; outro lead responde 404); mudar o dono para **outra pessoa** exige `leads.assign` (Admin Master, Diretoria, Gerente Comercial); assumir para si é `leads.write`.
- Cada mudança de etapa ou resultado é uma linha em **`lead_stage_history`** (append-only: de, para, ganho/perda, origem `wings | rd | import | sofia`, quem) e um evento na linha do tempo; dono mudado é evento `lead.owner_changed` com ids. Auditoria `lead.updated` com os campos que mudaram.
- **`leads.managed_by`**: `wings` quando o lead nasceu aqui com etapa/dono ou quando alguém o mexeu aqui; `rd` enquanto só espelha o RD. O importador e o seguimento por hora **não sobrescrevem** etapa, dono e resultado de um lead `wings`: só preenchem o que ainda está vazio. **Decisão do Eric (05/10): sem espelho Wings → RD de etapa e dono**; o RD só recebe a cópia na entrada (Lead Ads, intakes).

## Anotações e tarefas

- `lead_notes` (append-only; texto livre só na ficha do lead; o evento guarda id e tamanho). `POST /leads/:id/notes`.
- `lead_tasks`: tipo (`first_contact`, `follow_up`, `call`, `meeting`, `other`), título, vencimento, responsável (padrão: dono do lead), feita em/por. `POST /leads/:id/tasks`, `PATCH /leads/:id/tasks/:taskId` (`done`, `dueAt`, `title`), `GET /crm/tasks?status=open|overdue|done|all[&everyone=true]` (a lista do vendedor; `everyone` só para quem vê todos).
- **SLA de 1º contato** (Eric, 05/10): **1 hora útil**, contando só de segunda a sexta, 9h–18h (São Paulo); feriados ficam para depois. Quando um lead ganha dono (rodízio ou atribuição) e está em andamento, nasce a tarefa automática "Primeiro contato com o lead" vencendo em `addBusinessHours(agora, CRM_FIRST_CONTACT_SLA_HOURS)` (1 por padrão): lead de sexta 17h30 vence segunda 9h30. Trocar o dono passa a tarefa aberta para o novo dono.
- **Início de uso** (Eric, 09/10/2026): o SLA e os contadores só valem para negociação que **entrou** (`leads.entered_at`) a partir de `CRM_TRACKING_START` (dia `AAAA-MM-DD`, 00:00 de São Paulo; **2026-10-09** quando não definida). O histórico do RD (inclusive as de Expansão sem dono) fica como está e sai de: **"novas sem contato"** e **"atrasadas"** em Negociações (a resposta de `GET /leads/board/counters` traz `since`), o painel de Vendas ("1º contato atrasado"), o Escritório, os avisos `first_contact_overdue` e a lista de tarefas (`open`/`overdue`); `ensureFirstContactTask` não cria tarefa para elas. Só a tarefa `first_contact` é cortada: a tarefa que uma pessoa cria (retorno, ligação, reunião) conta em qualquer negociação. As tarefas de 1º contato que já existiam em negócio antigo não foram apagadas (continuam na ficha do lead), apenas deixam de contar e de avisar.

## Distribuição (`crm_distribution_members`)

- Um rodízio por funil: lead novo **sem dono** e **com funil** vai para o membro ativo que está há mais tempo sem receber (trava por funil, dois leads simultâneos vão a duas pessoas). Pausado não recebe e mantém os seus. Vazio: o lead fica sem dono até alguém assumir.
- Não distribui: importação do RD (o RD diz o dono), leads de Sofia até a transferência (`distribute: false`), lead manual (dono = quem cadastrou).
- Semente: os usuários do RD ligados a funcionários (`rd_user_map`) com papel `vendedor_expansao` → Expansão, `vendedor_formatacao` → Formatação. Administração → CRM adiciona, pausa e remove (só papéis de venda e gerente comercial).
- Eric (05/10): **rodízio também para a Sofia** — na Fase 4 a transferência chama o mesmo `nextInRotation`; o "sorteio" do pacote (`docs/whatsapp/regras-negocio.md` §6) fica substituído.

## Telas

- **Funil** (`/crm-vendas/funil`): Lista (como antes, "Parado há" agora é a etapa do Wings) ou **Kanban** por funil (coluna por etapa, contagem, até 60 cards por coluna, arrastar ou "Mover para…" no card; vendedor vê só os seus). Bloco **Meta Lead Ads** com o estado da fila e o botão **Buscar leads da Meta** (`integrations.manage`).
- **Ficha do lead**: "No funil" (funil, etapa, dono, ganho/perdido/reabrir), Tarefas, Anotações, Origem (com cidade e respostas do formulário), Cópia no RD CRM, Histórico de etapas, LGPD, Pesquisa, Linha do tempo.
- **Tarefas** (`/crm-vendas/tarefas`): abertas/atrasadas/concluídas/todas; gerente vê toda a equipe.
- **Administração → CRM** (`/administracao/crm`): etapas e distribuição.
- Sem 3D nestas telas (trabalho do dia a dia). Os painéis 3D do plano (funil, mapa, rede) vêm depois, em `/dashboard/comercial`.

## Testes

`crm-routes.test.ts` (etapas, rodízio + SLA, PATCH com escopo e `leads.assign`, perda/reabertura/ganho, notas, tarefas, kanban), `leads.test.ts` (Lead Ads), `rd-import.test.ts` (gap-fill de leads `wings`), `LeadsPage.test.tsx`. Rodar: `DATABASE_URL=... pnpm --filter @wings/api exec vitest run src/modules/leads`.

## Pendências

- Teste de tela do kanban e da ficha editável (browser, no staging).
- Etapas e vendedores: os do RD por enquanto (decisão do Eric, 05/10), ajustáveis em `/administracao/crm`. Feriados no cálculo do SLA.
- Painel técnico do Lead Ads com os eventos com falha (hoje só contagens no Funil).
