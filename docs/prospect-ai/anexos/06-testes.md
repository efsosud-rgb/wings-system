# Anexo 6 — Testes por PR

Parte da [especificação do Wings Prospect AI](../ESPECIFICACAO.md), seção 8. Código de referência: commit `c4168cb` da develop. Abreviações: `api` = `apps/api/src`, `web` = `apps/web/src`, `shared` = `packages/shared/src`, `worker` = `apps/worker/src`.

## 8.1 Regras para todos os PRs

- **Vitest**, teste ao lado do código (`<nome>.test.ts`), como manda `AGENTS.md` ("Tests").
- **Rede travada:** em `apps/api`, `apps/worker` e `packages/shared`, rodar sempre com `--config ../../vitest.config.ts`, que carrega `api/test/no-network.ts`. Nunca remover a trava nem contorná-la com mock. Toda chamada à Meta e ao OpenRouter passa por um `fetch` injetado (`deps.fetch`, como `createOpenRouterLlm({ fetch })` em `api/modules/agent/llm.ts:137` e o `graph()` de `api/modules/whatsapp/graph.ts:43-85`), e o teste injeta um falso.
- **Banco descartável por execução** (`createTestDatabase`, `api/test/db.ts:27`, a partir de `DATABASE_URL`). Dados fictícios de `api/test/factories.ts`; nenhum dado real de lead, nenhum @ real.
- **Segredos:** só valores falsos nos testes (ex.: segredo do app `test-app-secret-not-real`). Nenhum token real em fixture.
- **"Falha sem / passa com":** nos testes marcados ★, o autor do PR reverte só as linhas de produção que o teste protege, roda o teste (tem de falhar), desfaz a reversão e roda de novo (tem de passar). O resultado vai na descrição do PR.
- **Portão da CI** (`.github/workflows/ci.yml`), igual para todos: build, typecheck, lint, migrations do zero e seed **duas vezes** (o seed das permissões novas tem de ser idempotente), `pnpm test`, testes de escalada, `pnpm e2e`, nenhum arquivo novo com mais de 600 linhas (`scripts/arquivos-novos-grandes.sh`), format.
- **Prospecção Google sem regressão:** todo PR roda, sem alterar, a suíte atual: `api/modules/prospecting/prospecting.test.ts` (33), `maps-prospecting.test.ts` (16), `places-client.test.ts` (10), `site-reader.test.ts` (22), `shared/prospecting.test.ts` (11) e `web/pages/crm/ProspectingPage.test.tsx` (21). Contagens da CI 40763449806 e, a do web, por leitura estática.
- **Acesso:** toda rota nova declara o acesso no `preHandler`; `api/modules/auth/route-access.test.ts` falha se não declarar (:87). Ver §8.3.

## 8.2 Testes por PR

### (C) Base comum

| PR | Arquivo de teste | Casos (resultado esperado) |
|---|---|---|
| C1 | `shared/prospect-ai.test.ts` | ★ esquema de configuração: pesos que não somam 100 são recusados; texto da mensagem sem `{link_politica}` é recusado; placeholder desconhecido (`{nome}`) é recusado; `respostaPrivadaDias` > 7 e `janelaDirectHoras` > 24 são recusados; palavra-chave com espaço é recusada; slug de serviço repetido é recusado; `nao_identificada` não pode ser removido. Padrões batem com o anexo 1, §2.6 |
| C1 | `shared/leads.test.ts` (existente, acrescentar) | as 4 origens novas estão em `LEAD_SOURCES`, com rótulo e selo; o canal `instagram` continua aceito |
| C1 | `api/db/prospect-ai-schema.test.ts` | ★ CHECKs do banco: estado fora da lista, prioridade 101, `excerpt` com 281 caracteres, `secondary_categories` com 4 itens e `aprovada` sem `lead_id` falham na inserção; unique `(tenant_id, source, external_id)` da evidência e unique `(evidence_id)` da oportunidade recusam a segunda linha |
| C1 | `api/modules/auth/route-access.test.ts` (existente) | §8.3 |
| C2 | `api/modules/prospect-ai/opportunities.test.ts` | ★ transições: só as de §3.5 passam; `rejeitada` sem motivo é recusada; reabrir exige escopo `all`. ★ aprovar chama `upsertLead` com os campos de §3.6 e grava `lead_id`; se o `upsertLead` lança `ForeignLeadError`, a oportunidade não muda e a rota responde 409. ★ mesma oportunidade aprovada duas vezes (clique duplo) = um lead e **uma** linha `lead_events` de criação. Lead existente (mesmo telefone digitado pela pessoa): dono, etapa e origem não mudam, o histórico continua, só lacunas são preenchidas (`filled` no evento) |
| C2 | `api/modules/prospect-ai/priority.test.ts` (ou em `shared`) | nota de §3.7 para casos fixos (ex.: interesse declarado, serviço vendido, 2 h depois, texto da pessoa = valor exato); perfil ausente vale 0,5, nunca 0; nota muda ao trocar os pesos |
| C2 | `api/modules/prospect-ai/routes.test.ts` | ★ escopo: vendedor com `own` vê só as oportunidades dele; oportunidade sem dono é invisível para ele e responde **404** (padrão de `api/modules/leads/access.ts:22-23`); gerente (`all`) vê todas; vendedor sem `prospect_ai.review` recebe 403. Configuração: `PUT` só com `prospect_ai.configure` escopo `all`, grava `audit_log` com a parte e as chaves mudadas, **sem** o texto das mensagens no metadado |
| C3 | `api/modules/prospect-ai/classifier.test.ts` | ★ todos os casos de `classifier-cases.ts` (anexo 2, §4.10) com o LLM falso. Casos `regra` e `palavra_chave`: o LLM falso falha se for chamado. ★ `INJ-*`: resultado inválido ou revisão humana, conforme a tabela. ★ `PII-*` e `INJ06`: o texto que chegou ao LLM falso não tem `@`, e-mail nem sequência de 4+ dígitos, e tem no máximo 1.000 caracteres. Frase que não é substring → `invalid`. Categoria fora da lista → `invalid`. Sucessão com confiança 99 → revisão obrigatória |
| C3 | `api/modules/prospect-ai/classifier-budget.test.ts` | ★ teto: com `PROSPECT_AI_DAILY_USD` = 0,005 e reserva de 2.500 micro-dólares, a terceira chamada do dia é recusada e o resultado vem com `teto_ia`; 10 chamadas em paralelo nunca passam do teto (trava `prospect_ai_ceiling`); o dia vira à meia-noite de São Paulo. Custo do provedor substitui a reserva; chamada que caiu mantém a reserva |
| C3 | (mesmo arquivo) | ★ cache: o segundo texto igual (com caixa, acento e espaço diferentes) não chama o LLM e não grava linha de custo; mudar a lista de serviços ou o modelo invalida o cache; resultado inválido não entra no cache; nenhuma coluna guarda o texto |
| C3 | (mesmo arquivo) | modo sombra: grava `ia_sombra`, não muda a oportunidade, entra no mesmo teto; não roda se o teto não permitir |
| C4 | `web/pages/crm/OpportunitiesPage.test.tsx`, `web/pages/crm/ProspectAiSettingsPage.test.tsx` | estados de carregamento: falha mostra "—" e o motivo (`LoadFailure`), lista vazia só depois de leitura bem-sucedida; botões de decisão desabilitados sem permissão; confirmação dentro da tela (nunca `window.confirm`); rejeitar exige motivo; prazo vencido em destaque; Ajustes: erro do Zod aparece no campo, soma dos pesos mostrada ao vivo |
| C5 | `api/modules/prospecting/call-logs.test.ts` | ★ registrar ligação de prospect próprio funciona; de prospect de outro vendedor responde 404; gerente registra só em nome próprio (`employee_id` = ator). `called_at` mais de 7 dias no passado ou no futuro é recusado. ★ resultado `pediu_nao_contatar` grava pela função da trava (canal `phone`, ou `all`, conforme o PR da trava) **e** muda o prospect para `nao_contatar`. `prospect_calls` (livro da cota) não ganha linha |
| C5 | `web/pages/crm/CallLogDialog.test.tsx` | formulário, resultados possíveis, erro da API exibido |
| C6 | `web/pages/crm/LeadOriginTab.test.tsx`; `api/modules/prospect-ai/evidence-routes.test.ts` | aba mostra fonte, link, data, trecho e histórico de classificação; lead fora do escopo → 404 (usa `leadInScope`, `api/modules/leads/access.ts:51-60`); lead sem evidência mostra "Sem evidência registrada: este lead entrou por <origem>" |
| C7 | `api/modules/prospect-ai/housekeeping.test.ts` | ★ prazo: `respond_by` passado sem `responded_at` vira `prazo_vencido`; com `responded_at` não muda. ★ retenção: com o relógio avançado, evidência sem lead passa do prazo e é apagada ou anonimizada; evidência com lead fica; `ig_webhook_events.payload` vira nulo no prazo e a linha fica; `competitor_posts` some; cache some; `notes` de ligação vira nulo. Duas instâncias ao mesmo tempo: só uma roda (trava) |

### (D) Conector do Instagram

| PR | Arquivo de teste | Casos (resultado esperado) |
|---|---|---|
| D1 | `api/modules/instagram/webhook.test.ts` | ★ handshake: `hub.mode=subscribe` com o token certo devolve o `hub.challenge` em texto; token errado → 403. ★ assinatura: `X-Hub-Signature-256` calculada com o segredo falso sobre o **corpo bruto** passa; corpo alterado em 1 byte, cabeçalho ausente ou sem `sha256=` → 401 e nada gravado. ★ idempotência: o mesmo POST duas vezes → um evento por `event_key`; um POST com 2 entradas e 3 eventos → 3 linhas. Chave desligada → 503 e nada gravado. Sem segredo configurado → 503. Corpo não JSON → 400. Responde antes de processar (o processamento não roda dentro da requisição) |
| D1 | `shared/instagram.test.ts` | Zod tolerante: payloads de exemplo (comentário, comentário de anúncio, menção, mensagem, eco, referral, figurinha) viram o formato interno; campo desconhecido não quebra; falta de id → inválido. Exemplos marcados "não verificado ao vivo" |
| D1 | `api/modules/instagram/log.test.ts` | ★ segredos e dados fora do log: com um logger de captura, recebe um webhook e processa uma resposta privada; o log não contém o segredo do app, o token, o texto do comentário nem o @ (busca literal pelos valores falsos) |
| D2 | `api/modules/instagram/intake.test.ts` | ★ comentário com palavra-chave → 1 evidência, 1 oportunidade `nova`, revisão por confiança 60, `respond_by` = 7 dias. Comentário da própria conta da Wings → `ignored`. Comentário casual → `done` sem evidência nem oportunidade. Mensagem de quem não tem oportunidade, com interesse declarado e confiança ≥ 70 → lead. Eco → marca `responded_at`. ★ falha temporária (banco ou Graph falso fora) → `attempts` sobe e `next_attempt_at` segue 1, 5, 15, 60... minutos; na 8ª falha → `failed`. Evento repetido depois de `done` não reprocessa |
| D3 | `api/modules/instagram/graph.test.ts` | ★ limites: respostas falsas com HTTP 429 e com códigos 4, 17, 32, 613, 80002 e 80006 viram `rate_limited`; `estimated_time_to_regain_access` vira `paused_until`; a espera cresce a cada repetição e volta a zero depois de um sucesso. Código 10 ou 200 → `permission_denied`; 190 → `token_invalid`. Tempo esgotado ou 5xx num POST → `unknown`. O token vai no cabeçalho, nunca na URL |
| D3 | `api/modules/instagram/private-reply.test.ts` | ★ uma por comentário: dois processamentos do mesmo comentário (inclusive em paralelo) fazem **uma** chamada ao Graph falso. ★ fora do prazo: comentário com 7 dias e 1 minuto → `blocked`/`prazo_meta` e nenhuma chamada. ★ "não me contate" ativo no canal `instagram` (ou `all`) para o IGSID → `blocked`/`nao_contatar`, nenhuma chamada. Limite por pessoa e por hora (601ª resposta na mesma hora → `rate_limited`). `unknown` nunca é reenviado; `rate_limited` é reenviado só dentro dos 7 dias. O texto enviado é exatamente o de `settings.messages` com os dois links trocados (hash confere); nenhum caminho leva texto da IA ao envio |
| D3 | `web/pages/crm/SourcesPage.test.tsx` | estados: conectada (só depois de um evento recebido), com erro, pausada, aguardando a Meta, desligada; "—" e motivo quando a leitura falha |
| D3 | `api/modules/prospect-ai/source-alert.test.ts` | fonte ligada sem evento há mais que `alertaSemEventoHoras` → um aviso aos gerentes; não repete o aviso a cada hora |
| D4 | `api/modules/instagram/lead.test.ts` | ★ resposta no Direct à resposta privada → lead `instagram_comment`, canal `instagram`, base `pre_contract`, funil da categoria, dono do roteamento, tarefa de primeiro contato. ★ investidor → funil `expansao`; quem quer franquear → `formatacao`; outro serviço → `consultoria`. ★ mesma pessoa (mesmo IGSID) comenta de novo depois de virar lead → não cria outro lead, só evidência e `lead_events`. Comentário com `ad_id` → `instagram_ad` e `ad_external_id`; referral de anúncio → idem. Diagnóstico com `utm_content=op_<id>` liga a oportunidade ao lead `site_form` sem mudar a origem |
| D5 | `api/modules/instagram/erasure.test.ts` | ★ "parar" no Direct grava "não me contate" (canal `instagram`), fecha as oportunidades abertas e bloqueia a próxima resposta privada. Exclusão a pedido apaga `ig_people` e zera o trecho e o @ das evidências sem lead; com lead, o lead não é apagado aqui (segue o fluxo do lead). Exige `prospect_ai.configure` |

### (E) Radar de concorrentes

| PR | Arquivo de teste | Casos (resultado esperado) |
|---|---|---|
| E1 | `api/modules/prospect-ai/radar-routes.test.ts` | cadastrar conta só com `prospect_ai.configure`; @ inválido recusado; @ repetido → 409; listar posts ordena por comentários; post fora da janela não aparece |
| E2 | `api/modules/instagram/radar-job.test.ts` | ★ orçamento: com 30 contas e `radarChamadasPorHora` = 20, uma rodada faz no máximo 20 chamadas ao Graph falso; uso ≥ 80% no `X-App-Usage` encerra a rodada; código de limite para tudo e grava `paused_until`. Grava só id, link, data, legenda cortada em 150 e número de comentários (o teste confere as colunas: nada de comentário, autor ou curtida). Código 10 → fonte "aguardando a Meta"; 110 → conta `nao_encontrada`. Chave desligada → nenhuma chamada |
| E3 | `api/modules/prospect-ai/radar-registration.test.ts` | ★ pessoa física bloqueada: `tipo` diferente de `empresa` → 400 `radar_somente_empresa`, nada gravado. Sem canal oficial → 400. Link fora do Instagram → 400. Mesmo link duas vezes → 409 com o dono. 21º registro do dia → 429. ★ aprovar cria lead `competitor_radar` com `legitimate_interest` e `consent_source = 'prospeccao'`, e a trava do WhatsApp (`whatsappOptInMissing`, `shared/prospecting.ts:557-566`) passa a bloquear esse lead |
| E3 | `web/pages/crm/CompetitorRadarPage.test.tsx` | ★ escolher "Pessoa física" desabilita o botão e mostra o texto de LGPD; "Abrir no Instagram" usa o permalink; nenhum campo pede telefone pessoal |

### (F) Painel por fonte

| PR | Arquivo de teste | Casos (resultado esperado) |
|---|---|---|
| F1 | `api/db/bi-dw.test.ts` (existente, acrescentar) | as tabelas novas existem no `dw`, têm a linha 0 nas dimensões e RLS por tenant nos fatos; `wings_ro` lê as tabelas novas e **não** lê `ig_webhook_events` |
| F2 | `api/modules/prospect-ai/dw-load.test.ts` | ★ com um cenário fixo (leads de 3 fontes, oportunidades, mudanças de etapa, reunião, contrato e gasto de campanha), o fato bate com contagens feitas à mão; rodar a carga duas vezes dá o mesmo resultado (idempotente); fonte sem gasto fica **nula**, não zero; renomear a etapa "Reunião" muda a contagem (risco V3 documentado no teste); duas cargas em paralelo: uma espera a trava |
| F3 | `web/pages/crm/ProspectDashboardPage.test.tsx` | custo por lead qualificado mostra "—" e o motivo quando não há gasto ou não há qualificado; vendedor só vê a própria linha (o filtro de vendedor nem aparece); falha de leitura mostra `LoadFailure` |

## 8.3 Permissões e `route-access.test.ts`

Arquivo: `api/modules/auth/route-access.test.ts`. No PR C1:

- `PROBES` (:133) ganha `prospectAi: '/prospect-ai/opportunities'` e `prospectAiDashboard: '/prospect-ai/dashboard'`.
- `LEVELS` (:155) passa a abrir `prospectAi` para `vendedor_formatacao`, `vendedor_expansao`, `gerente_comercial`, `diretoria` e `admin_master`; `prospectAiDashboard` para os mesmos e para `marketing` (recomendação E8, **decisão do Eric**). Os outros papéis continuam com 403.
- A rota do webhook entra em `PUBLIC_ROUTES` (:22) no PR D1, com o motivo.
- Teste novo em `routes.test.ts` do módulo: o escopo `own` não vê oportunidade de outro (404), `all` vê; `prospect_ai.configure` só para gerente comercial e Admin.
- `docs/niveis-de-acesso.md` (tabela, :40) atualizado no mesmo PR.

## 8.4 Itens do plano ("Piloto, testes e critérios de aceite") → testes

| Item do plano | Teste que cobre | PR |
|---|---|---|
| Google: a suíte atual da prospecção passa sem alteração | os 6 arquivos de §8.1, sem mudança, em todo PR | todos |
| Intenção: conjunto de frases (12 exemplos, elogios, emojis, ironia, preço, investidores, fornecedores) | `classifier.test.ts` com `classifier-cases.ts` | C3 |
| CRM: o mesmo evento duas vezes gera um lead e uma interação | `webhook.test.ts` (idempotência do evento) + `intake.test.ts` (evento repetido não reprocessa) + `opportunities.test.ts` (aprovação dupla = 1 lead e 1 `lead_events`) | D1, D2, C2 |
| CRM: lead existente atualizado sem perder histórico, com dono | `opportunities.test.ts` (junção por telefone) + `lead.test.ts` (mesmo IGSID) | C2, D4 |
| CRM: o "não me contate" bloqueia WhatsApp, Sofia, e-mail, telefone e Instagram | WhatsApp, Sofia, e-mail e telefone: **testes do PR `feat/trava-unica-contato`** (não duplicar). Instagram: `private-reply.test.ts` e `erasure.test.ts`. Telefone na prospecção: `call-logs.test.ts` (registro grava a trava) | trava, D3, D5, C5 |
| Integração: assinatura inválida recusada e evento repetido ignorado | `webhook.test.ts` | D1 |
| Integração: Meta fora → nova tentativa com espera crescente, respeitando o limite de chamadas | `intake.test.ts` (espera da fila) + `graph.test.ts` (códigos de limite) + `radar-job.test.ts` (orçamento por hora) | D2, D3, E2 |
| Integração: resposta privada fora do prazo da Meta não é enviada | `private-reply.test.ts` | D3 |
| Segurança: segredos não aparecem em log | `log.test.ts` | D1 |
| Segurança: comentário com instrução maliciosa tratado como texto | `classifier.test.ts` (casos `INJ-*`) | C3 |
| Segurança: o vendedor só vê o que a permissão permite | `routes.test.ts`, `evidence-routes.test.ts`, `route-access.test.ts`, `ProspectDashboardPage.test.tsx` | C1, C2, C6, F3 |
| Retenção: dados de quem não virou lead apagados no prazo | `housekeeping.test.ts` | C7 |

## 8.5 Critérios do piloto e como medir

Medidos no staging, a partir das tabelas novas, num relatório semanal do gerente (consulta pelo `wings_ro`; sem dado pessoal no resultado). Esboços em SQL (`$ini`/`$fim` = período):

| Medida | Critério | Como medir |
|---|---|---|
| Google sem regressão | testes verdes, nenhuma mudança de comportamento | CI de cada PR + uma busca de conferência feita por um vendedor |
| Acerto do "interesse declarado" | ≥ 90% | `prospect_classifications` com `verdict` na amostra: `count(*) filter (where verdict='certo' and not 'intencao' = any(verdict_fields)) / count(*)`, só onde a intenção classificada ou a corrigida é `interesse_declarado` |
| Acerto da categoria principal | ≥ 80%, por categoria | idem, `group by category`, olhando `'categoria' = any(verdict_fields)` |
| Falsos positivos | ≤ 15% | `count(*) filter (where state='rejeitada') / nullif(count(*) filter (where state='aprovada'),0)` em `prospect_opportunities`, por fonte |
| Duplicidades | ≤ 2% | leads do período com o mesmo `ig_people.igsid` (via `ig_people.lead_id`), o mesmo telefone ou o mesmo e-mail que outro lead: `count(distinct lead_id duplicado) / count(*)` |
| Tempo até a primeira resposta no Direct | até 1 hora útil; 100% dentro de 24 h | `responded_at − prospect_evidence.occurred_at` das oportunidades do Instagram (horas úteis pela mesma regra de `ensureFirstContactTask`, `api/modules/leads/crm.ts:764`); % com `responded_at <= respond_by` |
| Custo por lead qualificado, por fonte | medir e comparar | visão do painel (anexo 5) |
| Conversão por fonte | registrar | visão do painel: aprovado → reunião → proposta → contrato |
| Estabilidade | nenhum evento perdido | `ig_webhook_events` com `status='failed'` no período = 0; eventos com `attempts > 1` e erros de limite (`prospect_source_health`) só registrados |
| Oposição respeitada | zero | `select count(*) from ig_private_replies r join ig_people p on p.id = r.ig_person_id where r.status='sent' and exists (opt-out ativo do IGSID no canal instagram ou all, criado antes de r.sent_at)` = 0; mais `prospect_call_logs` depois de um "pediu_nao_contatar" do mesmo prospect = 0 |

## 8.6 Teste de ponta a ponta

Os fluxos ficam em `apps/api/e2e/flows/*.mjs` (`convites`, `escalada`, `integracoes`, `leads`, `segredos`), rodados por `pnpm e2e` (`apps/api/package.json:12`) contra a API real num banco `wings_e2e` descartável, com a trava de rede.

Sugestão para o PR D4: `apps/api/e2e/flows/instagram.mjs`, com a API subida com chaves ligadas e segredo **falso**:

1. `GET /api/integrations/instagram/webhook` com o token falso devolve o desafio.
2. `POST` de um comentário "FRANQUIA" assinado com o segredo falso → 200; o mesmo POST de novo → 200 e nenhum evento novo.
3. O laço processa: há uma oportunidade `nova`; a resposta privada fica `blocked` (o Graph é a rede travada, então o fluxo roda com `INSTAGRAM_AUTO_REPLY_ENABLED` desligada e confere o motivo `desligado`).
4. `POST` de uma mensagem do mesmo IGSID "quero franquear minha marca" → um lead `instagram_comment` no funil Formatação, com dono; repetir a mensagem não cria outro lead.
5. Um vendedor sem a oportunidade não a vê (404); o gerente vê.
6. O log do processo não contém o segredo falso nem o texto.
