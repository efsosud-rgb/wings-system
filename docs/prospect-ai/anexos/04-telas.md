# Anexo 4 — Telas

Parte da [especificação do Wings Prospect AI](../ESPECIFICACAO.md), seção 6. Código de referência: commit `c4168cb` da develop. Abreviações: `web` = `apps/web/src`, `shared` = `packages/shared/src`, `api` = `apps/api/src`.

## 6.0 Regras que valem para todas as telas

- **Padrão do CRM Vendas.** Rotas no bloco do CRM em `web/router.tsx:86-116` (a Prospecção está em :111). O menu não tem arquivo próprio: os itens ficam no módulo `crm-vendas` de `shared/navigation.ts:136-280`, no molde do item Prospecção (:151-158, com `permission` em :156), e o web filtra por `visibleNavigation` (`web/components/AppShell.tsx`). O menu só esconde; quem decide o acesso é a API (`AGENTS.md`, "How the parts relate").
- **Arquivos novos**, nunca dentro das páginas grandes: `ProspectingPage.tsx` (1.650 linhas), `DealPage.tsx` (2.167) e `DealTabs.tsx` (628) já passam de 600 e só ganham a linha que chama o componente novo. Cada arquivo novo fica abaixo de 600 linhas (`scripts/arquivos-novos-grandes.sh`); se crescer, divide por componente (`XxxPage.tsx` + `XxxCard.tsx`).
- **Cliente da API:** um arquivo novo `web/api/prospect-ai.ts`, no molde de `web/api/prospecting.ts:57-74` (react-query; chaves começando com `['prospect-ai', ...]`; `useSave<Parte>` que invalida `['prospect-ai']`). Erros chegam como `ApiError` com `status` e `code` (`web/api/client.ts:16`).
- **Componentes da casa:** `Field`, `Input`, `Select`, `Button`, `Alert` (`web/components/ui.tsx:10,49,53,57,64`); `LoadFailure` e `Unavailable` (`web/components/LoadFailure.tsx:9,37`) com `failureReason` (`web/lib/failure.ts:19`); `PageHeader` com abas (`web/components/PageHeader.tsx:4,19`); `StudioLayout` (`web/components/StudioLayout.tsx:52`) só onde já é o padrão; `ConfirmDialog` (`web/components/agenda/ConfirmDialog.tsx:11`, `role="alertdialog"`) para toda confirmação, **nunca `window.confirm`**; `Modal` exportado de `web/pages/crm/CreateDealModal.tsx`; o visual de cartão é a classe `.crm-card` (`web/crm.css:563`). Não há componente de selo, cartão ou estado vazio genérico: os selos usam o mesmo padrão de `LEAD_SOURCE_BADGES` (`shared/crm.ts:902`).
- **Quatro estados em toda lista e todo número:**
  1. *Carregando:* "Carregando…" no lugar do conteúdo, sem números.
  2. *Erro:* `LoadFailure` com "—" e o motivo (regra do `AGENTS.md`). Nunca lista vazia nem zero no lugar do erro.
  3. *Vazio:* o texto de vazio **só depois de uma leitura bem-sucedida**.
  4. *Sem permissão:* a rota responde 403 e a tela mostra `Unavailable` com "Você não tem acesso a esta área." O item some do menu.
- **Textos** em português do Brasil, sem jargão. Datas no fuso de São Paulo. Contagens regressivas em "faltam 3 h 20 min" e, vencido, "venceu há 2 h".
- **Acessibilidade:** todo campo com `Field` (rótulo ligado ao campo); botões só com ícone têm `aria-label`; modal prende o foco e devolve o foco ao botão que o abriu; cor nunca é o único sinal (o prazo vermelho também diz "faltam menos de 2 h"); a fila funciona só com teclado (Tab entre cartões, Enter abre o detalhe).
- **Nenhum dado pessoal em log ou em telemetria do web.** A tela mostra o @ e o trecho a quem tem permissão (é o produto); nada disso vai para `console`.

### Itens novos do menu (módulo `crm-vendas`)

| Rota | Rótulo | `permission` | `kind` | Descrição curta (campo `description`) |
|---|---|---|---|---|
| `/crm-vendas/oportunidades` | Oportunidades | `prospect_ai.review` | o mesmo de Negociações | "Comentários, Direct e radar, revisados antes de qualquer contato" |
| `/crm-vendas/radar` | Radar de concorrentes | `prospect_ai.review` | idem | "Posts mais comentados de concorrentes; você lê no Instagram e registra empresas" |
| `/crm-vendas/painel-prospeccao` | Painel por fonte | `prospect_ai.dashboard` | idem | "Encontrados, qualificados, reuniões e contratos por fonte, com custo" |
| `/crm-vendas/fontes` | Fontes | `prospect_ai.review` | idem | "Google, Instagram, formulários e anúncios: ligado, com erro ou pausado" |

A página de Ajustes (`/crm-vendas/oportunidades/ajustes`) não entra no menu: abre pelo botão "Ajustes" da Fila, visível só com `prospect_ai.configure`.

---

## 6.1 Fila de oportunidades — `/crm-vendas/oportunidades` (PR C4)

**Arquivos:** `web/pages/crm/OpportunitiesPage.tsx` (lista, filtros, abas) e `web/pages/crm/OpportunityCard.tsx` (cartão e ações). Hooks: `useOpportunities(filtros)`, `useOpportunity(id)`, `useOpportunityDecision`, `useOpportunityClassification`, `useOpportunityAssign`, `useOpportunityResponded`, `useOpportunityOptOut`.

**Layout:** `PageHeader` com título "Oportunidades", botão "Ajustes" (só `prospect_ai.configure`) e abas por estado, cada uma com a contagem que a API devolve:

| Aba | Estado | Ordem da lista |
|---|---|---|
| Novas | `nova` | prazo (`respond_by`) mais próximo primeiro; depois prioridade, da maior para a menor |
| Em revisão | `em_revisao` | idem |
| Aprovadas | `aprovada` | `decided_at` mais recente primeiro |
| Rejeitadas | `rejeitada` | idem |
| Duplicadas | `duplicada` | idem |
| Prazo vencido | `prazo_vencido` | `respond_by` mais recente primeiro |

Oportunidade sem `respond_by` (radar) vem depois das que têm prazo, ordenada por prioridade.

**Filtros** (linha acima da lista, `Select`): Fonte (Comentário, Direct, Anúncio, Menção, Radar), Categoria (lista de `settings.services`), Dono ("Meus", "Sem dono" e os nomes — "Sem dono" e os nomes só aparecem com escopo `all`). Os filtros ficam na URL (`?estado=&fonte=&categoria=&dono=`) para o link poder ser compartilhado.

**Cartão** (`.crm-card`), de cima para baixo:

1. **Quem:** empresa (radar) ou `@usuario` (Instagram), com o selo da fonte.
2. **Selos, quando houver:** "Não me contate" (vermelho, com o canal e a data, vindo da trava única); "Envio não confirmado" (resposta privada em `unknown`, com a dica "Confira no Instagram se a mensagem chegou"); "Possível duplicada" (o @ bate com `leads.instagram` de outro lead); "Revisão obrigatória" com o motivo em texto (`confianca_baixa` → "Confiança abaixo de 70%", `revisao_obrigatoria` → "Serviço sempre revisado por uma pessoa", `servico_nao_vendido` → "Serviço que a Wings não vende hoje", `sem_ia` → "Sem classificação automática", `teto_ia` → "Limite diário de IA atingido", `registro_manual` → "Registrado à mão no radar").
3. **Classificação:** categoria principal (nome do serviço) e secundárias; intenção ("Interesse declarado", "Necessidade provável", "Conteúdo educativo", "Comentário casual", "Outro assunto", "Informação insuficiente"); **Prioridade** "72/100" e **Confiança** "85%", sempre separadas e com rótulo.
4. **A frase:** a justificativa entre aspas, destacada dentro do trecho da evidência, e o link "Ver no Instagram" (permalink do post ou link do comentário do radar; Direct não tem link público, então o botão é "Abrir o Direct no Instagram", que abre `https://www.instagram.com/direct/inbox/`).
5. **Dono** (nome) ou "Sem dono".
6. **Prazo:** "Responder até 14:30 · faltam 3 h 20 min". Abaixo de 2 h, texto e borda em vermelho **e** a frase "faltam menos de 2 h". Vencido: "Prazo vencido há 2 h". Já respondido: "Respondido às 11:05".

**Ações** (botões no rodapé do cartão; os que a pessoa não pode usar não aparecem):

| Botão | Quem vê | O que faz | Rota |
|---|---|---|---|
| Aprovar | `prospect_ai.review` + `leads.write` | Abre o `Modal` "Aprovar oportunidade": mostra o funil que a categoria indica e, se a categoria for "Necessidade não identificada" ou sem funil, exige escolher Expansão, Formatação ou Consultoria. Confirmar → cria ou junta o lead | `POST /prospect-ai/opportunities/:id/decision` `{ action: 'approve', pipeline? }` |
| Revisar | idem, em `nova` | Passa para "Em revisão" | `... /decision` `{ action: 'review' }` |
| Corrigir | `prospect_ai.review` | `Modal` com categoria, secundárias (até 3) e intenção. Nas duas primeiras semanas do piloto o modal pede também "A classificação anterior estava: Certa / Errada" e, se errada, "O que estava errado: Categoria / Intenção" | `POST /prospect-ai/opportunities/:id/classification` |
| Rejeitar | `prospect_ai.review` | `ConfirmDialog` com motivo obrigatório (3 a 300 caracteres). Sem motivo, o botão "Rejeitar" fica desabilitado com a dica "Escreva o motivo" | `... /decision` `{ action: 'reject', reason }` |
| Marcar duplicada | `prospect_ai.review` | `Modal` para buscar o lead ou a oportunidade original (por nome da empresa, @ ou id) | `... /decision` `{ action: 'duplicate', duplicateOfLeadId \| duplicateOfOpportunityId }` |
| Atribuir | escopo `all` | `Select` de vendedores ativos com `prospect_ai.review` | `POST /prospect-ai/opportunities/:id/assign` |
| Respondi | dono ou escopo `all` | Marca a primeira resposta humana (quando a Meta não mandar o eco). Some depois de usado | `POST /prospect-ai/opportunities/:id/responded` |
| Registrar "não me contate" | `prospect_ai.review` | `ConfirmDialog` "Registrar que esta pessoa não quer ser contatada pelo Instagram? Nenhuma resposta automática será enviada a ela." com opção "Em todos os canais" | `POST /prospect-ai/opportunities/:id/opt-out` `{ channels }` |
| Reabrir | escopo `all`, em Rejeitadas e Duplicadas | `ConfirmDialog` "Voltar esta oportunidade para revisão?" | `... /decision` `{ action: 'reopen' }` |
| Abrir no Instagram | todos | Link externo (`target="_blank"`, `rel="noopener noreferrer"`) | — |

**Respostas de erro** (mensagens em `Alert` dentro do modal ou do cartão):

| Código da API | Texto |
|---|---|
| 409 `foreign_lead` (`ForeignLeadError`) | "Já existe um lead com este contato, de outro vendedor ({nome}). Peça ao gerente para juntar." |
| 409 `number_in_attendance` | "Este contato já está em atendimento. Fale com {nome} antes de aprovar." |
| 409 `estado_mudou` | "Alguém já mudou esta oportunidade. A lista foi atualizada." (e recarrega) |
| 400 `invalid` | a mensagem do Zod, ao lado do campo |
| 404 | "Esta oportunidade não existe ou não está mais com você." |

**Vazios** (só depois de ler com sucesso):
- Novas: "Nenhuma oportunidade nova. Quando alguém comentar a palavra-chave ou escrever no Direct, ela aparece aqui."
- Em revisão: "Nada esperando revisão."
- Prazo vencido: "Nenhum prazo vencido. Bom trabalho."
- Demais abas: "Nenhuma oportunidade neste estado."
- Com filtro: "Nenhuma oportunidade com estes filtros." + botão "Limpar filtros".

**Atualização:** a lista relê a cada 60 s (`refetchInterval`), como a fonte processa em ciclos de 60 s; a contagem regressiva anda no cliente a cada minuto, sem nova leitura.

---

## 6.2 Ajustes — `/crm-vendas/oportunidades/ajustes` (PR C4)

**Arquivo:** `web/pages/crm/ProspectAiSettingsPage.tsx` (se passar de 600 linhas, um arquivo por seção: `ProspectAiServicesForm.tsx` etc.). Hooks: `useProspectAiSettings()` e `useSaveProspectAiPart(parte)` → `PUT /prospect-ai/settings/:part`.

**Acesso:** a página lê com `prospect_ai.review`; os campos só ficam editáveis com `prospect_ai.configure` de escopo `all`. Sem ela, tudo aparece somente para leitura com a nota "Só o gerente comercial altera estes ajustes."

**Seções** (uma `.crm-card` cada, com seu botão "Salvar", no molde de `SettingsTab`/`SaveRow`/`IcpForm` em `ProspectingPage.tsx:1501-1609`; cada formulário roda o `safeParse` do `shared` antes de enviar, como `ProspectingPage.tsx:1554`):

| Seção | Campos | Validação na tela | Notas na tela |
|---|---|---|---|
| Serviços | tabela: nome, funil (Expansão / Formatação / Consultoria / Só revisão), "A Wings vende hoje" (sim/não), "Sempre revisar" (sim/não), sinais (até 5 frases) | slug gerado do nome e travado depois de salvo; "Necessidade não identificada" não pode ser removida | "Serviço que a Wings não vende não vira lead." |
| Palavras-chave | lista: palavra, serviço, mensagem, ativa | uma palavra só, sem espaço; repetida → "Esta palavra já existe" | "A palavra precisa aparecer inteira no comentário. 'franquiado' não conta como FRANQUIA." |
| Mensagens | texto de cada mensagem, link do diagnóstico, link da política de privacidade | 20 a 1.000 caracteres; **tem de conter `{link_politica}`** ("A mensagem precisa ter o link da política de privacidade."); contador de caracteres | Aviso fixo em `Alert`: "Texto aprovado pelo Eric. Toda mudança fica na auditoria." Prévia ao lado com os links já trocados, exatamente como a pessoa vai receber |
| Pesos da nota | seis campos inteiros | soma ao vivo: "Soma: 100" em verde; diferente de 100 → "A soma precisa dar 100 (está em 95)" e "Salvar" desabilitado | "Prioridade e confiança são medidas separadas." |
| Limites | respostas por hora, dias entre respostas à mesma pessoa, chamadas do radar por hora, registros do radar por vendedor por dia, janela e atualização do radar, alerta "fonte sem evento" | faixas do anexo 1 §2.6; acima do teto da Meta → "A Meta permite no máximo 750 por hora" | — |
| Prazos | dias da resposta privada, horas da janela do Direct, horas úteis para a primeira resposta | até 7 dias e até 24 h: "Limite da Meta" | — |
| Retenção | os sete prazos do anexo 1 §2.6 | faixas do Zod | Selo "A validar com o advogado" ao lado do título |
| Dono do Instagram | `Select` de vendedores ativos com `prospect_ai.review`, ou "Rodízio do funil" | — | "No piloto, uma pessoa fixa responde o Direct." |

**Salvar:** sucesso → "Ajustes salvos." (`Alert` verde que some em 5 s); erro 400 → mensagem ao lado do campo pelo `path` que a API devolve (formato de `invalid()`, `api/modules/prospecting/routes.ts:99-104`); 403 → "Só o gerente comercial altera estes ajustes."

**Ligação com a Prospecção atual:** a aba Ajustes de `ProspectingPage.tsx` (painel em :1501) ganha só uma linha de texto com link: "Serviços, palavras-chave e mensagens do Instagram ficam em Oportunidades → Ajustes."

---

## 6.3 Central de fontes — `/crm-vendas/fontes` (PR D3)

**Arquivo:** `web/pages/crm/SourcesPage.tsx`. Hook `useSources()` → `GET /prospect-ai/sources` (relê a cada 60 s); `usePauseSource()` → `POST /prospect-ai/sources/:source/pause` e `.../resume`.

**Layout:** `PageHeader` "Fontes" e uma `.crm-card` por fonte, em grade.

**Estados** (o selo do cartão; um só por vez, nesta precedência):

| Estado | Quando | Cor e texto |
|---|---|---|
| Desligada | chave de ambiente desligada (anexo 3) ou variável que falta | cinza: "Desligada neste ambiente" |
| Aguardando a Meta | último erro da Graph é 10, 190 ou 200, ou o token não está configurado | âmbar: "Aguardando a Meta: falta permissão ou aprovação" |
| Pausada | `settings.sources.<fonte>.pausada = true` | cinza: "Pausada por {nome} em {data}" (do `audit_log`) |
| Em espera | `prospect_source_health.paused_until` no futuro (limite da Graph) | âmbar: "Em espera até 15:40 (limite da Meta)" |
| Com erro | eventos `failed` nas últimas 24 h, ou erro mais recente que o último sucesso | vermelho: "Com erro" + o código e a hora |
| Conectada | **só depois de receber pelo menos um evento** e sem nenhum dos estados acima | verde: "Conectada · último evento há 12 min" |
| Sem eventos ainda | ligada, sem erro, mas nunca recebeu evento | cinza: "Ligada, ainda sem nenhum evento" |

**O que cada cartão mostra:**

| Fonte | Dados | De onde vem |
|---|---|---|
| Google (prospecção) | buscas e fichas do mês contra o teto; chamadas do vendedor no dia | `GET /prospecting/usage` existente (`api/modules/prospecting/routes.ts:165`), sem mudança |
| Instagram | estado; último evento; eventos e falhas nas últimas 24 h; respostas privadas enviadas na última hora contra o limite; "em espera até" | `ig_webhook_events`, `ig_private_replies`, `prospect_source_health` |
| Radar de concorrentes | contas ativas; última leitura; erros por conta | `competitor_accounts`, `prospect_source_health` |
| Formulário da Meta | último recebido; falhas nas últimas 24 h | `meta_leadgen_events` (`received_at`, `status`) |
| Site | último lead `site_form` | `leads` (`source`, `created_at`) |
| RD Station | último lead `rd_station` | `leads` |
| Google Ads (formulário) | último lead `google_lead_form` | `leads` |

Fonte sem nenhum lead no período mostra "Nenhum lead nos últimos 30 dias" (é um fato lido, não um erro).

**Ações:** "Pausar" e "Retomar" só para Instagram e Radar, só com `prospect_ai.configure`. Pausar abre `ConfirmDialog`: "Pausar o Instagram? Nenhuma resposta automática sai enquanto estiver pausado. Os eventos continuam sendo recebidos e guardados." O botão "Ver erro" abre um `Modal` com código, hora e o que fazer (mapa fixo: `permission_denied` → "Falta permissão no app da Meta. Veja o checklist da Fase 2."; `token_invalid` → "O token venceu ou foi revogado. Peça um novo no Gerenciador de Negócios."; `rate_limited` → "A Meta pediu para esperar. O sistema tenta de novo sozinho.").

**Erro de leitura:** `LoadFailure`: "— Não foi possível ler o estado das fontes ({motivo})."

---

## 6.4 Radar de concorrentes — `/crm-vendas/radar` (PR E3)

**Arquivos:** `web/pages/crm/CompetitorRadarPage.tsx` e `web/pages/crm/RadarRegisterModal.tsx`. Hooks: `useRadarAccounts()`, `useSaveRadarAccount()` (`POST /prospect-ai/radar/accounts`, `PATCH /prospect-ai/radar/accounts/:id`), `useRadarPosts(filtros)` (`GET /prospect-ai/radar/posts`), `useRadarRegister()` (`POST /prospect-ai/radar/registrations`).

**Aviso fixo no topo** (`Alert` informativo, não pode ser fechado):
> "O sistema mostra só os posts públicos das contas cadastradas, pela API oficial da Meta. Os comentários você lê no próprio Instagram. Registre aqui apenas **empresas**, com o canal oficial delas. Nada de copiar telefone de perfil pessoal nem de mandar mensagem em massa."

**Abas** (`PageHeader`): "Posts" e "Contas".

**Aba Posts:** filtros Ramo (Consultoria de franquias, Consultoria empresarial, Mentoria, Coaching empresarial) e Período (7, 14 ou 30 dias, até `limits.radarJanelaDias`). Lista ordenada por número de comentários, do maior para o menor; cada linha: conta (@), ramo, data do post, legenda curta, "123 comentários" (ou "—" quando a Meta não informou), botões "Abrir no Instagram" e "Registrar empresa". Vazio: "Nenhum post nas contas cadastradas neste período." Sem contas: "Cadastre as contas de concorrentes na aba Contas." Fonte desligada ou aguardando a Meta: `Unavailable` com o mesmo texto da Central de fontes.

**Aba Contas** (edição só `prospect_ai.configure`): tabela com @, ramo, ativa, última leitura e o erro por conta ("Conta não encontrada ou não é comercial", "Sem permissão na Meta", "Em espera pelo limite"). "Adicionar conta": @ (sem arroba; validação `^[a-z0-9._]{1,30}$`) e ramo. Repetida → "Esta conta já está no radar."

**Modal "Registrar empresa"** (`RadarRegisterModal.tsx`, `Modal`):

1. Rádio obrigatório **"Quem comentou é:"** "Empresa" / "Pessoa física". Escolher "Pessoa física" desabilita todos os outros campos e o botão "Registrar", e mostra em `Alert`: **"Pessoa física não entra no radar (LGPD). Só registre empresas."**
2. Nome da empresa (obrigatório, 2 a 120).
3. @ da empresa no Instagram (opcional).
4. Link do comentário (obrigatório; precisa começar com `https://www.instagram.com/`: "Cole o link do comentário no Instagram").
5. Data do comentário (opcional; padrão hoje).
6. Trecho do comentário (opcional, até 280, contador): "Copie só a frase que mostra a necessidade."
7. **Canal oficial da empresa**: site, telefone comercial, WhatsApp comercial, e-mail comercial; pelo menos um ("Informe pelo menos um canal que a própria empresa publica.").
8. Caixa obrigatória: "Confirmo que é uma empresa e que o canal acima é publicado por ela."

Respostas: sucesso → fecha e mostra "Empresa registrada. Ela está na fila de oportunidades." com link para a Fila; 400 `radar_somente_empresa` → o `Alert` de pessoa física; 409 `radar_ja_registrado` → "Este comentário já foi registrado por {nome}."; 429 `radar_limite_dia` → "Você chegou ao limite de {n} registros hoje."

---

## 6.5 Aba "Origem e evidência" no lead (PR C6)

**Arquivos:** `web/pages/crm/LeadOriginTab.tsx` (novo). Em `web/pages/crm/DealTabs.tsx`, o tipo `View` (:29) ganha `'origin'` e a lista `VIEWS` (:31-38) ganha `{ key: 'origin', label: 'Origem e evidência' }`; o componente `DealTabs` (:569) renderiza `LeadOriginTab` nessa aba. `DealPage.tsx` (:219) não muda. Hook `useLeadEvidence(leadId)` → `GET /prospect-ai/leads/:leadId/evidence`.

**Acesso:** a rota exige `leads.read` e confere o lead com `leadInScope` (`api/modules/leads/access.ts:51-60`): fora do alcance responde 404 ("Este lead não existe ou não está com você."), como o resto do lead. A aba aparece para todos que veem o lead; o botão de correção só com `prospect_ai.review`.

**Conteúdo:**

1. **Origem do lead** (sempre, mesmo sem evidência): origem (`LEAD_SOURCE_LABELS`), canal, base legal (`LEAD_LEGAL_BASES`, com o rótulo), `consent_source`, campanha e anúncio quando houver.
2. **Evidências** (lista, mais recente primeiro): fonte, data, link ("Ver no Instagram" ou "Ver comentário"), trecho, base legal, "guardada até {data}" ou "segue a retenção do lead", "registrada por {nome}" ou "automática". Vazia: "Este lead não veio pelo Prospect AI. A origem acima é a registrada na entrada."
3. **Histórico da classificação** (tabela): data, método ("Palavra-chave", "Regra", "IA", "IA (comparação)", "Pessoa"), modelo, categoria, intenção, confiança, frase, veredito do piloto ("Certa"/"Errada") e quem corrigiu.
4. Botão **"Corrigir classificação"** → o mesmo modal "Corrigir" da Fila (§6.1), sobre a oportunidade ligada.

Erro de leitura: `LoadFailure` com "— Não foi possível ler a origem deste lead ({motivo})." A aba não mostra o IGSID (é id técnico).

---

## 6.6 Painel de prospecção — `/crm-vendas/painel-prospeccao` (PR F3)

**Arquivo:** `web/pages/crm/ProspectDashboardPage.tsx`. Hooks `useProspectDashboard(filtros)` → `GET /prospect-ai/dashboard`; `useProspectDashboardRefresh()` → `POST /prospect-ai/dashboard/refresh` (botão só com `prospect_ai.configure`). Definições e cálculo no [anexo 5](05-painel-por-fonte.md).

**Filtros:** Período (Últimos 7 dias, Últimos 30 dias, Este mês, Mês passado, Personalizado), Fonte, Funil (Expansão, Formatação, Consultoria), Vendedor (só escopo `all`; com escopo `own` o filtro não aparece e a API força o próprio vendedor). Filtros na URL.

**Blocos:**

1. **Funil por fonte** (tabela; uma linha por fonte, colunas na ordem do funil): Encontrados → Qualificados → Aprovados → Contatados → Reuniões → Propostas → Contratos, cada célula com o número e a taxa até a etapa anterior ("12 · 40%"). Célula sem dado: "—" com o motivo em `title` e em nota de rodapé numerada (catálogo de motivos no anexo 5). A linha de uma fonte **com erro** na Central fica em destaque (borda vermelha e "Fonte com erro desde {hora}: os números podem estar incompletos").
2. **Custo por lead qualificado** por fonte e por campanha (só para quem vê custo, ver anexo 5): "R$ 190,29" ou "—" + motivo ("fonte sem custo de mídia", "a plataforma não informou o gasto").
3. **Leads por categoria** (barras horizontais, uma cor só, com o número escrito ao lado de cada barra).
4. Rodapé: "Atualizado em {carregado_em}" e o botão "Recalcular" (`ConfirmDialog`: "Recalcular os últimos 35 dias? Leva alguns minutos."). Durante o recálculo: "Recalculando…" e o botão desabilitado; 409 `carga_em_andamento` → "Já existe um recálculo em andamento."

**Vazio** (leitura bem-sucedida, sem nenhuma linha): "Nenhum dado no período. A primeira carga roda toda madrugada." **Nunca zero no lugar de "sem dado".**

---

## 6.7 Registrar ligação (PR C5)

**Arquivo:** `web/pages/crm/CallLogModal.tsx`. Hooks `useCallLogs({ prospectId | leadId })` → `GET /prospecting/calls`; `useLogCall()` → `POST /prospecting/calls`.

**Onde aparece:** botão "Registrar ligação" no cartão do prospect (`ProspectCard`, `ProspectingPage.tsx:1307`, só a linha do botão e do modal) e na página do lead (`DealPage.tsx`, junto das ações do topo; só a linha do botão). Os dois com `prospecting.use` e o escopo dele (o vendedor só registra nos próprios).

**Campos:** resultado (obrigatório, rádio): "Atendeu, interessado", "Atendeu, pediu retorno", "Atendeu, sem interesse", "Não atendeu", "Caixa postal", "Número errado", "Pediu para não ser contatado"; data e hora (padrão agora; até 7 dias no passado); duração em minutos (opcional); anotação (até 1.000, contador); "Retornar em" (data e hora, aparece em "Atendeu, pediu retorno").

**"Pediu para não ser contatado":** ao salvar, `ConfirmDialog`: "Registrar que esta empresa não quer contato? O telefone e todos os canais ficam bloqueados para toda a equipe." Confirmar grava a ligação e, pela função da trava única, o "não me contate".

**Histórico:** abaixo do botão, as últimas 5 ligações ("Hoje 10:12 · Não atendeu · Daniele"). Vazio: "Nenhuma ligação registrada."

---

## 6.8 Rotina da equipe (do plano) e a tela de cada passo

| Quando | Quem | O que faz | Tela |
|---|---|---|---|
| Começo do dia, 15 min | Vendedor e pessoa do Direct | Abre a Fila na aba "Novas", ordenada pelo prazo; responde primeiro quem está perto de perder a janela de 24 h do Direct (selo vermelho); marca "Respondi" | §6.1 |
| Durante o dia | Vendedor | Prospecção Google: reserva até 40 empresas, liga e registra cada ligação | Prospecção atual + §6.7 |
| Durante o dia | Vendedor | Radar: abre os posts mais comentados, lê no Instagram, registra só empresas | §6.4 |
| Fim do dia | Vendedor | Aba "Em revisão": revisa confiança baixa; registra "não me contate" pedidos no dia | §6.1 |
| Piloto, semanas 1 e 2 | Gerente | Marca "Certa/Errada" em 100% das classificações (depois, 20%) | §6.1, modal Corrigir |
| Uma vez por semana | Gerente | Lê o painel por fonte; ajusta palavras-chave e pesos; confere a Central | §6.6, §6.2, §6.3 |

---

## 6.9 Testes de tela (detalhe no anexo 6)

Cada página nova traz `XxxPage.test.tsx` ao lado (padrão do `web`, que já carrega a trava de rede no próprio `vitest.config.ts`), cobrindo no mínimo: os quatro estados (carregando, erro com "—", vazio só depois da leitura, sem permissão); os botões que somem sem permissão; o rádio "Pessoa física" desabilitando o registro do radar; a soma dos pesos travando o "Salvar"; a mensagem sem `{link_politica}` recusada; o `ConfirmDialog` no lugar de `window.confirm`.
