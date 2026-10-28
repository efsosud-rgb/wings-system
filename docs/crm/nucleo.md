# CRM Vendas — núcleo e redesenho (05/10/2026)

Branch `feat/crm-nucleo`, migração **0065** `crm_nucleo` (gerada sobre a 0064; renumerar no merge se outra entrar antes). Segue a Fase 1 (`trabalho.md`); este documento diz o que mudou.

## Telas (menu CRM Vendas: Negociações, Prospecção, Contatos, Empresas, Tarefas, Painel em breve, Configurações)

- **Prospecção** (`/crm-vendas/prospeccao`, desde 26/10): empresas do Google Maps ao vivo para o funil Formatação; ver `prospeccao.md`.
- **Negociações** (`/crm-vendas/negociacoes?funil=`): kanban em tela inteira (padrão), Lista, Atividades (todas as tarefas do funil por dia) e Calendário (tarefas e reuniões por data). Cabeçalho com seletor de funil (Expansão, Formatação, Consultoria), contadores (novas sem contato, atividades de hoje, atrasadas), "Regras de automação" (`/crm-vendas/configuracoes/automacoes/:pipeline`, página do Sonnet), "+ Criar" e menu ⋮ (importar/exportar CSV). Abas Todas / Minhas / Sem dono / visões salvas (`crm_saved_views`, por pessoa). Filtros numa linha (busca por nome, empresa, e-mail, telefone; dono; situação, perdidas fora por padrão; origem; marca em Expansão; parados há N dias; ordenação) e avançados (criação, última atividade, campanha, etapa).
- Coluna = etapa: pílula colorida com quantidade, soma e valor ponderado pela **probabilidade da etapa** (`crm_stages.probability`, em Configurações). "+ Negócio rápido" na primeira coluna; "Carregar mais" por coluna (30 por página, `GET /leads/board/column`). Card: nome, empresa, contato, valor, iniciais do dono, tempo na etapa, próxima tarefa (vermelha se atrasada), selo de origem (Meta, Google, RD, Site, WhatsApp, Manual, Planilha) e marca; no hover: ligar, e-mail, tarefa, ganho, perda.
- **Ficha**: topo com nome, empresa, valor (edição inline), dono, funil, barra de etapas clicável, Marcar venda / Marcar perda; esquerda contatos (vários por negociação, `lead_contacts`), empresa e marca, origem (UTM, campanha, respostas do formulário, pesquisa); centro abas Anotação, Tarefa, Ligação (resultado, duração, observação), Reunião (data, participantes, link do Meet), E-mail (em breve), WhatsApp (em breve) e linha do tempo única; direita prazo do 1º contato com contagem regressiva, próximas tarefas, dono.
- **Criar negociação**: modal (nome, empresa, telefone, e-mail, valor, funil, etapa, dono — rodízio por padrão para quem atribui —, marca, origem). Base legal padrão: interesse legítimo.
- **Tarefas**: Atrasadas / Hoje / Próximas, filtro por dono (quem atribui) e tipo, conclusão na linha.
- **Contatos** e **Empresas**: busca, ficha com negociações, duplicados (`crm.manage`) com "Manter este" (mescla: preenche lacunas, move vínculos, retira o outro com `merged_into_id`). Empresa → **Virar cliente** (`clients.manage`) cria o cliente pelo mesmo caminho de "Novo cliente" (número, Drive, projeto).
- **Configurações**: etapas (nome, ordem, ativa, probabilidade), distribuição por funil, marcas de interesse (= clientes com `franchise_on_sale`; "à venda" aparece para o vendedor e no filtro).
- **Administração → Integrações**: quadro "Fontes de negócios" (`GET /crm/sources`), estado de cada porta em linguagem simples.

## Dados

- `crm_companies` (nome, `name_key`, CNPJ único entre vivas, telefone, e-mail, site, cidade/UF, segmento, `client_id`, `merged_into_id`), `crm_contacts` (nome, e-mail e telefone únicos entre vivos, cargo, `company_id`, `merged_into_id`), `lead_contacts` (lead ↔ contato, principal), `lead_activities` (ligação/reunião, append-only), `crm_saved_views`; `leads.company_id`, `leads.value_cents`, `leads.expected_close_at` (migração 0068: `date`, aceita vazio, sem padrão; a previsão de fechamento que o vendedor marca na ficha, lida pelo Painel de vendas como `expectedCloseAt`, `AAAA-MM-DD`, na ficha, na lista e no quadro; `PATCH /leads/:id/deal` aceita `expectedCloseAt` com data ou `null`; evento `lead.expected_close_changed`; aberta e com o dia passado = "vencida", `isCloseForecastOverdue` em `@wings/shared`); `crm_stages.probability`. A migração cria um contato por pessoa já conhecida (telefone, depois e-mail) e liga cada lead; marca as etapas com probabilidade crescente; cria a etapa de entrada de Consultoria; e **refaz o rodízio** (Eric, 05/10): Expansão → Fernando; Formatação e Consultoria → Thais (por primeiro nome entre vendedores ativos; conferir em Configurações).
- Toda chegada (`upsertLead`) acha ou cria o contato e a empresa; nada se duplica por e-mail, telefone, CNPJ ou nome normalizado. Origem `csv_import` nova.

## Rotas novas

`/crm/contacts[/:id|/merge]`, `/crm/companies[/:id|/merge|/:id/client]`, `/leads/:id/contacts[/:contactId]`, `/leads/:id/activities`, `PATCH /leads/:id/deal`, `/crm/brands[/:id]`, `/leads/board` (filtros da lista + `pipeline`, `mine`), `/leads/board/column`, `/leads/board/counters`, `/crm/views[/:id]`, `/crm/sources`, `GET /leads/export.csv` (escopo de quem pede; auditoria com contagens), `POST /leads/import/preview` e `/leads/import` (`import_batch_id` por rodada).

## Tema

`apps/web/src/theme.css` é o ponto central: direção A "Claro e leve" (fundo #F5F4F1, superfícies brancas, texto #1D1B19, botão #C8461A, marca #E95228, pílulas claras por etapa, Plus Jakarta Sans; Limelight só em títulos de exibição). Os nomes antigos `--wings-*` apontam para os tokens, então as telas antigas seguem o tema. `:root[data-theme='dark']` guarda o conjunto escuro. As telas do CRM (`crm.css`) só usam tokens. Slot do logo oficial: `#wings-logo-slot` no topo do menu (componente do Sonnet).

## Pendências

- Conferência no browser pelo Eric (staging): arrastar cards, filtros, importação com planilha real, "Virar cliente".
- Feriados no SLA; e-mail e WhatsApp pelo CRM (Sonnet); Painel (Sonnet); regras de automação (Sonnet).
- Vendedores = só Eric, Thais e Fernando: papéis dos outros usuários em Administração → Usuários (não é coisa de migração).
