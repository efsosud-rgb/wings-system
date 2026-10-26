# Wings Ads Intelligence

Tela: **Marketing → Wings Ads Intelligence** (`/marketing/ads-intelligence`). Junta num lugar só o
que o módulo de anúncios já tinha (contas, aprovações, operações, alertas) e acrescenta três
coisas: a **auditoria por regras**, gravada e priorizada; os **pacotes de anúncio com IA**; e o
estado da **API de Conversões da Meta** ([conversions-api.md](conversions-api.md)).

Nada nesta tela chama a Meta ou o Google. A auditoria lê o espelho que a ingestão já gravou. Um
pedido criado a partir de uma recomendação passa pelo guardião de orçamento (`reserveChange`) e
pelo portão de aprovação (`gateChange`) como qualquer outro, e só é executado pelo botão de
sempre, em Aprovações, por quem tem `ads.approve`. O bloqueador de automação de
[travas.md](travas.md) continua valendo: quem pede é uma pessoa, uma alteração por vez.

## Abas

| Aba             | O que mostra                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Visão geral     | Credenciais por plataforma ("conexão pendente" quando faltam), contas espelhadas, aprovações pendentes, resultados desconhecidos, alertas abertos, última ingestão e falhas, API de Conversões, últimos 15 pedidos |
| Auditoria       | Rodar por canal (todos, Meta, Google) e período (7, 14, 30, 90 dias); histórico; comparação com o período anterior; recomendações por prioridade                                                                   |
| Anúncios com IA | Pacote com variações A/B, briefing do criativo, roteiro de vídeo, sugestão de público e de estrutura; pré-visualização; o que as regras recusaram e por quê                                                        |

Desempenho por campanha, criativo e público continua no Dashboard de Marketing, e os insights
semanais da IA na aba "Insights e sugestões". A tela aponta para lá em vez de repetir.

## A auditoria

`apps/api/src/modules/ads/audit.ts`. `loadSnapshot` lê o banco uma vez; `evaluateAudit` é uma
função pura sobre essa leitura (testada sem banco); `runAudit` grava a rodada e as recomendações.
O que já tinha regra é reaproveitado: o veredito por campanha e a "Saúde da conta" do Dashboard,
os alertas do Cockpit, a regra de compliance do construtor e o período do guardião.

| Verificação              | De onde vem                                                                          | Inspirada em (claude-ads) |
| ------------------------ | ------------------------------------------------------------------------------------ | ------------------------- |
| `conversion_source`      | Saúde da conta + alerta `conversion_silence`                                         | M01                       |
| `conversions_api`        | `META_CAPI_ENABLED` + jobs `meta_capi_lead` dos últimos 7 dias                       | M02, M03                  |
| `data_freshness`         | `ad_campaigns.last_synced_at` (26 h) e última reconciliação (120 min)                | M10                       |
| `data_consistency`       | gasto por campanha × soma dos anúncios no período (5% e R$ 1)                        | —                         |
| `campaign_performance`   | veredito do Dashboard (negativa = problema, atenção = atenção) + alerta de qualidade | —                         |
| `active_without_results` | Saúde da conta                                                                       | M-ST2                     |
| `spend_pacing`           | Saúde da conta                                                                       | M17                       |
| `creative_fatigue`       | Saúde da conta                                                                       | M28, M-CR2                |
| `creative_diversity`     | formatos dos anúncios ativos (Meta)                                                  | M25                       |
| `ad_policy`              | alerta `ad_rejected`                                                                 | —                         |
| `copy_compliance`        | `checkCopyCompliance` no texto dos anúncios ativos                                   | —                         |
| `tracking_utms`          | alertas de UTM e de sufixo do Google                                                 | M39                       |
| `budget_headroom`        | período do mês e trava da conta                                                      | M-ST1                     |
| `pending_operations`     | pedidos com resultado desconhecido e aprovações com mais de 48 h                     | —                         |

Referência dos controles: AgriciDaniel/claude-ads, `ads/references/meta-audit.md` (licença MIT).
Só os nomes e a ideia de cada controle foram usados; nenhum código foi copiado nem instalado.

Cada recomendação tem situação (problema, atenção, em ordem, sem dado, não se aplica), impacto,
confiança e esforço. **Prioridade = peso da situação × impacto × confiança ÷ esforço** (alto 3,
médio 2, baixo 1; problema 2, atenção 1, sem dado 0,5), de 0 a 18. "Sem dado" nunca aparece como
"em ordem", e uma plataforma sem conta conectada diz isso em vez de passar.

### De uma recomendação a um pedido

A auditoria só propõe **pausar** uma campanha ativa com veredito negativo. Nunca propõe ativar,
retomar nem aumentar verba. "Criar pedido" (`POST /ads/intelligence/findings/:id/request`, exige
`ads.request`):

1. confere que a campanha ainda está no espelho e que o sistema tem esse pedido (mesma regra do
   agente, `changeCard`);
2. **numa transação só**, marca a recomendação como `requested` só se ela ainda estiver `open` e
   chama `reserveChange`. Dois cliques, ou duas instâncias da API, terminam em um 201 e um 409, e
   uma queda no meio não deixa reserva nem marca pela metade;
3. depois do commit, `gateChange` abre a aprovação e avisa os aprovadores.

O pedido é da pessoa (`requested_by`), com `requested_by_agent = false` e `suggested_by_agent =
true`, e o motivo começa com "Sugerido pela auditoria (Ads Intelligence)". Recusa do guardião
(trava, teto, período fechado) marca a recomendação como `refused` e grava
`audit_finding.refused_by_guard`.

## Pacotes de anúncio com IA

`apps/api/src/modules/ads/ad-copy.ts`. Uma chamada ao modelo do agente (`AGENT_MODEL`, OpenRouter),
obrigada a responder pela ferramenta `registrar_pacote`, sem internet. Vai ao modelo: o que a
pessoa digitou e o cliente ideal salvo no studio, os dois limpos de telefone, e-mail e CPF
(`scrubDeep`). A resposta passa por regras, não por confiança:

- todo texto passa pela regra de compliance do construtor (promessa de ganho, payback, renda por
  mês, linguagem de investimento);
- limites de cada plataforma (Meta: título 40, texto principal, chamada para ação da lista; Google:
  título 30, descrição 90);
- **nenhum número que a pessoa não digitou** em "O que é anunciado", "Para quem" ou "Fatos
  autorizados" (`inventedNumbers`). Preço, condição, prazo e resultado inventados são recusados.
  Vale também para o texto na tela do roteiro de vídeo.

Cada variação é julgada sozinha: as recusadas aparecem com o motivo. Sem `OPENROUTER_API_KEY` a
rota responde 503 e a tela desliga o botão. O custo entra no mesmo teto diário por pessoa do agente
(`AGENT_DAILY_USD`, somado às mensagens do agente); estourou, 429. Limite de 6 pedidos por minuto
por pessoa, contado no banco. Cada pessoa vê só os próprios rascunhos. O pacote é texto: para
virar campanha, a pessoa leva o texto ao construtor, e a campanha nasce pausada e passa pela
aprovação.

## Rotas

| Rota                                          | Permissão                            |
| --------------------------------------------- | ------------------------------------ |
| `GET /ads/intelligence/overview`              | `ads.read`                           |
| `GET /ads/intelligence/audits`                | `ads.read`                           |
| `POST /ads/intelligence/audits`               | `ads.read` (6 por minuto por pessoa) |
| `GET /ads/intelligence/audits/:id`            | `ads.read`                           |
| `POST /ads/intelligence/findings/:id/request` | `ads.request`                        |
| `POST /ads/intelligence/findings/:id/dismiss` | `ads.request`                        |
| `GET /ads/intelligence/copy-drafts`           | `ads.read`                           |
| `POST /ads/intelligence/copy-drafts`          | `ads.request`                        |

Contrato em `packages/shared/src/ads/intelligence.ts`. Nenhuma permissão nova: quem já vê
campanhas vê a auditoria; quem já pede campanhas cria pedidos e gera anúncios; aprovar continua com
Admin Master e Diretoria.

## Tabelas (migração `0103_ads_intelligence`, número provisório)

- `ad_audit_runs`: uma por auditoria (canal, período, contagens, comparação, quem pediu).
- `ad_audit_findings`: uma por verificação. Só `state` e o pedido mudam depois, e só a partir de
  `open`; índice único em `change_request_id`.
- `ad_copy_drafts`: um pacote por geração (pedido, resposta aceita, recusas, modelo, tokens,
  custo, erro).

Só cria tabelas; não altera nenhuma existente. Para desfazer (antes de haver dado que importe):
`DROP TABLE ad_audit_findings, ad_audit_runs, ad_copy_drafts;` e a linha da 0103 no
`drizzle.__drizzle_migrations`. Recebe `GRANT SELECT` para `wings_ro` quando o
papel existe. O número 0103 é provisório: o PR #30 define a numeração final da fila.

Auditoria: `ads.audit_run`, `audit_finding.requested`, `audit_finding.refused_by_guard`,
`audit_finding.dismissed`, `ads.copy_generated`. Metadados levam ids, tipos e contagens, nunca
texto.

## Modelo dimensional

`dw.fato_midia_diaria` (migração 0060) não é carregada por nenhum código hoje, então a auditoria lê
as tabelas operacionais (`ad_metrics_daily` e as do espelho), as mesmas do Dashboard. Nenhum fato
nem dimensão nova foi criado. Quando a carga do DW existir, a comparação de períodos pode passar a
ler de lá.

## Testes

- `apps/api/src/modules/ads/intelligence.test.ts`: autorização por perfil; auditoria contra banco
  descartável; dois cliques simultâneos fazem um pedido só; trava da conta recusa pelo guardião;
  ponta a ponta (auditoria → recomendação → pedido → aprovação → execução no `FakeMetaClient` com
  timeout depois de aplicar → resultado desconhecido → nada repete → `resolve-unknown` lê a
  plataforma); pacotes de IA com modelo roteirizado (503 sem chave, recusas, limpeza de e-mail,
  teto diário, isolamento por pessoa).
- `packages/shared/src/ads/intelligence.test.ts`: prioridade, números inventados, limites por
  plataforma, compliance.
- `apps/web/src/pages/AdsIntelligencePage.test.tsx`: "conexão pendente", "—" com motivo, botão só
  para quem pode, pré-visualização.
