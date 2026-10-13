# Origem completa do lead

Desde 13/10/2026 (ordem do orquestrador, aprovada pelo Eric).

## Na ficha: o card "Origem"

Mostra só o que a entrada trouxe. Quando ela não trouxe nada, o card diz "—" e o motivo.

- **Anúncio (Meta, Google, TikTok):** campanha, conjunto e anúncio, com nome e id. O nome vem das tabelas `ad_campaigns`, `ad_sets` e `ad_ads`, pelos ids que o lead guarda (`ad_campaign_external_id`, `ad_set_external_id`, `ad_external_id`). Quando a conta ainda não foi lida, aparece "nome ainda não lido da conta" e o id.
- **Site e LPs:**
  - as UTMs (`utm_source` a `utm_term`);
  - a origem que o RD deu à visita ou ao negócio (`leads.traffic_source`, como "Tráfego Direto" ou "Busca Paga | Google");
  - o formulário que converteu (`leads.conversion_identifier`, o `conversion_identifier` do RD);
  - a página.
- **Respostas do formulário:** investimento disponível, observações, nome da empresa, Instagram, site e cidade.

## De onde vêm as respostas

| Entrada                        | Campos lidos                                                                                                                                                                                     | Onde ficam                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conversão do RD (webhook)      | `cf_investimento_disponivel_para_franquia_75_a_100_mil` (e qualquer `cf_investimento_disponivel…`), `cf_observacoes`, `company`, `cf_instagram`, `website`, `city`, e `conversion_origin.source` | respostas em `form_answers` ("Investimento disponível", "Observações"); empresa, Instagram e site nos campos do lead; cidade em `city`; origem em `traffic_source` |
| Negócio do RD CRM (importação) | campos personalizados pelo rótulo: "Investimento disponível para franquia - 75 a 150 mil", "Observações", "Nome da Marca", "OBS"; e a fonte do negócio (`deal_source`)                           | `form_answers` e `traffic_source`                                                                                                                                  |

**Não verificado:** onde o RD põe esses campos na entrega real do webhook. O leitor procura no conteúdo da conversão, nos campos do contato e em `custom_fields`. Vale conferir com a primeira entrega depois do deploy. Um lead que já existia só ganha o que estava vazio; nada é sobrescrito. Os leads antigos não têm esses dados até uma nova conversão ou uma nova importação do RD.

## Quem vê

Os dados vêm dentro de `GET /leads/:id`, que só responde a quem tem `leads.read` no escopo do lead (`leadInScope`). Quem não pode ver o lead recebe 404 e não vê nada disso. A lista e o quadro não trazem esses campos.

## No Dashboard de Marketing: funil por campanha e por anúncio

A aba Funil conta, por campanha e por anúncio, os leads do próprio Wings System que entraram no período (`apps/api/src/modules/ads/dashboard/funnel-crm.ts`):

- **No CRM:** os leads da campanha ou do anúncio.
  - Pela campanha: o id de campanha que o lead guarda; senão, a `utm_campaign`, comparada com a UTM do rascunho, o nome e o id da campanha, sem acento nem maiúscula.
  - Pelo anúncio: o id do anúncio; senão, a `utm_content` do lead comparada com a do anúncio.
- **Reuniões:** os leads que chegaram a uma etapa com "Reunião" no nome. Vale a etapa mais adiantada, pela etapa atual ou pelo histórico, mesmo que o lead tenha sido perdido depois.
- **Propostas:** a mesma regra, para etapa com "Proposta" no nome. Uma venda conta nas duas.
- Lead marcado como suspeito de robô, sem a marca tirada por uma pessoa, não conta (ver `docs/leads/suspeitos.md`).
- **Fora das campanhas:** os leads sem anúncio nem UTM de campanha conhecida aparecem só como total, abaixo das plataformas (`leadsWithoutCampaign`).

As linhas por plataforma continuam vindo das etiquetas do RD (`crmUnattributed`). `matchedSiteCampaigns` é a sessão do GA4 casada com a campanha. Ela fica vazia enquanto o GA4 não estiver ligado: em 13/10, `ga4_traffic_daily` estava vazia no staging. A contagem de leads por campanha não depende do GA4.
