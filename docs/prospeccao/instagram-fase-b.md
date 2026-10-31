# Prospecção Instagram — Fase B construída (parte 3: Business Discovery na nota de 0 a 100)

Construída em 31/10/2026 (tarefa ig03) a partir da [especificação](instagram.md), §1.3, §2.2, §6, §8.4 e §10 (Fase B). Esta página diz o que existe, onde está e o que ficou diferente da especificação. **Nada liga sozinho:** a consulta à Meta fica desligada até o Eric conferir o token (B0) e ligar a chave.

## Como se usa

CRM Vendas → Prospecção → **Busca** (quem tem `prospecting.use`), como hoje.

1. A busca do Google responde e cada empresa traz o Instagram conhecido, nesta ordem: o que o **site da própria empresa** mostrou (guardado em `prospects.enrichment`, com a data), senão o **site informado no Google** quando ele é `instagram.com/<@>` (lido ao vivo, nunca gravado ligado ao `place_id`). Link de post (`/p/…`, `/reel/…`) não conta como perfil.
2. A tela pede os números das empresas com Instagram, 20 por vez. A coluna **Instagram** mostra o @, de onde ele veio, seguidores, posts, a média de curtidas e de comentários dos posts recentes e "Meta, lido em DD/MM". Sem dado: "—" e o motivo.
3. A coluna **ICP (0–100)** passa a contar o Instagram e ordena a lista. Passar o mouse mostra cada critério que contou, os que ficaram fora por falta de dado, "N de M pontos" e a data da leitura.

## A nota

`nota = round(100 × pontos obtidos ÷ pontos possíveis)` (`icpScore` e `withInstagram`, `packages/shared/src/prospecting.ts`).

- **Google** (regras de antes): nota, avaliações, site, Instagram achado no site, várias unidades. Pontos possíveis com os pesos padrão: 9.
- **Instagram**, só quando a Meta deu o dado: seguidores ≥ 10.000 (+2) ou ≥ 1.000 (+1); 4 ou mais posts nos últimos 30 dias (+2); 100 ou mais posts (+1); engajamento ≥ 1% (+2); média ≥ 5 comentários por post (+1). Com todos os dados: 8 possíveis, 17 no total.
- Critério sem dado sai **dos dois lados** (nunca vale zero). Conta pessoal, privada ou inexistente, ou Meta fora: a nota fica só com o Google, também de 0 a 100, e a empresa não é marcada como suspeita.
- Engajamento = (média de curtidas + média de comentários) ÷ seguidores. Curtidas ocultas (nenhum post trouxe `like_count`) tiram só esse critério.
- Pesos: Ajustes → Pesos ICP (`PUT /prospecting/settings/icp`, `prospecting.configure`: Gerente Comercial e Admin Master), de 0 a 10, auditados como antes.

## Onde está

| Peça                                                        | Arquivo                                                                       |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Nota 0–100, pesos novos e Zod                               | `packages/shared/src/prospecting.ts`                                          |
| Contrato da consulta, motivos, mapa de erros da Graph       | `packages/shared/src/instagram-discovery.ts`                                  |
| Tabelas (migração `0106_prospect_instagram_discovery`)      | `apps/api/src/db/schema/prospecting.ts`                                       |
| Cliente da Graph, leitura dos números, cabeçalhos, tíquete  | `apps/api/src/modules/prospecting/instagram-graph.ts`                         |
| Cache, teto do dia, espera, expurgo                         | `apps/api/src/modules/prospecting/instagram-discovery.ts`                     |
| Rota e o @ na resposta da busca                             | `apps/api/src/modules/prospecting/routes.ts`, `service.ts` (`instagramRefOf`) |
| Expurgo de 30 dias (a cada hora, junto com o da Fase A)     | `apps/api/src/modules/prospect-ai/housekeeping.ts`                            |
| Tela                                                        | `apps/web/src/pages/crm/ProspectInstagram.tsx`, `ProspectingPage.tsx`         |
| Ajustes → Instagram (cache, consultas por dia, posts lidos) | `apps/web/src/pages/crm/InstagramProspectList.tsx` (`InstagramSettings`)      |

## A chamada

```text
GET /v23.0/{INSTAGRAM_DISCOVERY_ACCOUNT_ID}?fields=business_discovery.username(<@>){username,followers_count,media_count,media.limit(12){like_count,comments_count,timestamp}}
```

Token no cabeçalho `Authorization`, nunca na URL ou no log. O log guarda só o status, a porcentagem de uso e o formato da resposta (nomes de campos e números), nunca o @. Não pede nome, bio, site, foto, legenda nem link.

## Chave e configuração

| Variável                                                      | Padrão  | O que faz                                                                                                            |
| ------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `INSTAGRAM_BUSINESS_DISCOVERY_ENABLED`                        | `false` | Desligada (ou sem as duas abaixo), a rota responde 503 e a coluna diz "consulta ao Instagram desligada"              |
| `INSTAGRAM_DISCOVERY_ACCOUNT_ID`, `INSTAGRAM_DISCOVERY_TOKEN` | —       | As mesmas da conferência de Instagram do lead do site ([../leads/instagram.md](../leads/instagram.md)); nada de novo |

Ajustes → Instagram (`prospect_ai_settings.settings.instagram.discovery`, `prospect_ai.configure`): dias de cache (7; 1–30), consultas à Meta por dia (500; 0–2.000), posts recentes lidos (12; 3–25).

## Rota

| Rota                                    | Permissão         | O quê                                                                                                                                                                                                                                             |
| --------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /prospecting/instagram/discovery` | `prospecting.use` | `{ items: [{ username, ticket }] }`, 1 a 20. Por @: os números (do cache ou lidos agora) ou o motivo do "—"; `holdUntil` (espera da Meta) e o uso do dia. 503 `instagram_discovery_off` desligada; 400 pedido inválido. `Cache-Control: no-store` |
| `GET /prospecting/status`               | `prospecting.use` | ganha `instagramDiscovery` (ligada e configurada?)                                                                                                                                                                                                |
| `POST /prospecting/search`              | `prospecting.use` | cada resultado ganha `instagram: { username, source, at, ticket } \| null`; `icp` passa a `{ score (0–100), earned, possible, reasons, noData }`                                                                                                  |

## Limites

- **Cache:** um @ lido há menos de `cacheDias` não gasta outra chamada, para nenhum vendedor. Leitura com erro não fica no cache.
- **Teto do dia** (São Paulo): cada chamada grava uma linha em `instagram_discovery_calls` sob trava **antes** de sair; a 501ª (padrão) não chama a Meta e responde "limite de consultas do dia". Uma chamada que falhou conta.
- **Espera:** cabeçalho `X-App-Usage` ou `X-Business-Use-Case-Usage` em 80% ou mais, erro de limite (4, 17, 32, 613, 80002) ou de permissão (10, 190, 200) param as chamadas pelo tempo que a Meta der (`estimated_time_to_regain_access`) ou por 60 minutos; a tela mostra "Instagram em espera até HH:MM".
- **Erros:** 110, 24, subcódigo 2207013 e 100 "invalid user id" = `nao_comercial` ("a Meta só mostra conta comercial; esta é pessoal, privada ou não existe"); 10, 190, 200 = "a Meta recusou a consulta"; o resto = "a Meta não respondeu". O mapa é o mesmo da conferência do lead do site (agora em `shared`).

## LGPD

- **Só empresa vai à Meta:** a busca assina cada @ para o vendedor que buscou (HMAC derivado do `SESSION_SECRET`, 12 horas); a rota recusa @ sem esse tíquete ("este @ não veio da busca do Google") e não chama a Meta. O @ de quem comentou (partes 1 e 2) nunca tem tíquete.
- **O que fica:** `instagram_business_snapshots` guarda o @ da empresa, números, `source = meta_business_discovery`, `api_version` e `fetched_at`. Nunca nome, bio, site, foto, legendas, ids de mídia nem `place_id`. Apagada 30 dias depois de `fetched_at`.
- `instagram_discovery_calls` guarda quem pediu e quando, nunca o @.
- Sem `GRANT` para `wings_ro` e nada no `dw`.

## O que ficou diferente da especificação (opção mais segura; perguntas no relatório da ig03)

- **Tíquete assinado** (a especificação não pedia): é a API, e não a tela, que garante "nunca o @ de quem comentou" (§1.3, passo 4).
- **Pesos do Instagram junto dos pesos ICP** (`prospecting_settings.icp.weights`), e não em `prospect_ai_settings.instagram.weights`: mesmo formato, mesma tela, mesma permissão (`prospecting.configure`, como manda o §9) e mesma auditoria. Uma linha salva antes lê os pesos novos com o padrão, sem perder a lista de exclusão.
- **Pontos possíveis** = o maior peso de cada faixa exclusiva (nota, avaliações, seguidores), não a soma de todos: é o que dá os "9 pontos com os padrões" do §6.3 e deixa 100 alcançável.
- **Teto do dia numa tabela própria** (`instagram_discovery_calls`), e não em `prospect_calls`: assim a consulta à Meta não come a cota diária de chamadas ao Google do vendedor.
- **Espera também no erro de permissão** (10, 190, 200), por 60 minutos: as chamadas seguintes falhariam igual.
- **Espera guardada na memória do processo da API.** Com mais de uma réplica, cada uma aprende o limite na própria chamada (no máximo uma chamada a mais por réplica).
- **Central de fontes:** ainda não existe (spec PA, F1). O erro de permissão aparece na coluna para quem busca e no log; o aviso à gerência fica para a Central.
- **Mapa de erros no `shared`:** a conferência de Instagram do lead do site (worker) passa a usar o mesmo mapa; com isso o erro 80002 lá também diz "Limite de consultas da Meta".

## Falta para ligar (fora da CI)

B0 (Eric): conferir as permissões do `INSTAGRAM_DISCOVERY_TOKEN` (`instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`; [instagram-meta-lgpd.md](instagram-meta-lgpd.md) §7.1–7.2) e fazer uma Business Discovery de teste; então ligar `INSTAGRAM_BUSINESS_DISCOVERY_ENABLED=true` no Coolify do staging e ver a coluna preenchida para uma empresa real de teste. **Não verificado ao vivo:** os campos de `media` e os cabeçalhos de uso seguem a referência da Meta; o log de formato mostra a resposta real na primeira chamada.
