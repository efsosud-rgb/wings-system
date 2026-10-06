# Formulário de leads no anúncio

Onda de 2026-10-06 (branch `feat/formulario-no-anuncio`). O construtor de campanhas do Agente de
Tráfego Pago ganhou a seção **Formulário**: numa campanha de geração de leads, a pessoa escolhe onde
o lead responde e o sistema mostra, antes de qualquer escrita, como o anúncio fica com o formulário.
Nada é publicado sem aprovação; a criação real só acontece pelo gate, com `ADS_WRITES_ENABLED`.

## O formulário padrão da Wings

Uma definição só (`packages/shared/src/ads/lead-form.ts`), usada pela Meta e pela página do site:

| Parte                        | Regra                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pergunta de múltipla escolha | **Opcional, desligada por padrão**, editável por campanha (sugestão: "Quantas unidades você tem hoje?" · 1 / 2 a 5 / 6 a 20 / Mais de 20). De 2 a 5 opções, sem repetir. Na Meta vai com a chave fixa `qualificacao`, que não mapeia campo nenhum.                                                                                           |
| Cinco perguntas obrigatórias | Nome (`FULL_NAME`/`full_name`), WhatsApp (`PHONE`/`phone_number`), Nome da empresa (`COMPANY_NAME`/`company_name`), Instagram da empresa (`CUSTOM`/`instagram`), Site da empresa (`CUSTOM`/`site`). Fixas: o teste `lead-form.test.ts` garante que cada texto e cada chave caem no campo certo por `leadFieldOfQuestion` (`lead-fields.ts`). |
| Política de privacidade      | Link `https://`. O construtor lê os formulários atuais da Página (`GET /ads/meta/lead-forms`) e oferece **a política que eles usam** como padrão.                                                                                                                                                                                            |
| Agradecimento                | Título (60), texto (200), botão (30). Na Meta o botão leva à página de destino da campanha.                                                                                                                                                                                                                                                  |
| Funil                        | `pipeline` + marca/cliente. Na Meta, a regra `meta_form` **nasce junto com o formulário**; na página do site, o funil é o da regra da página.                                                                                                                                                                                                |
| Compliance                   | Pergunta e agradecimento passam pelo mesmo `checkCopyCompliance` dos textos do anúncio.                                                                                                                                                                                                                                                      |

A identidade de um formulário (`leadFormFingerprint`) é perguntas + política + agradecimento, sem o
funil: a mesma definição na mesma Página é **um só formulário na Meta**, criado uma vez.

## Meta: formulário instantâneo

Seção Formulário → "Onde o lead é captado": **Na página para onde o botão leva** (como antes: pixel,
`destination_type: WEBSITE`) ou **No anúncio (formulário instantâneo)**. Com o formulário no anúncio,
o rascunho leva `leadCapture: 'instant_form'` e `leadForm`, e a execução (`ad-tree.ts`) ganha o passo
**`lead_form`** entre a mídia e o conjunto:

1. Um formulário com a mesma definição já criado na Página (`ad_lead_forms`) é reaproveitado — o passo
   diz "(reaproveitado)" e nada é escrito.
2. Senão, `POST /{page_id}/leadgen_forms` com o **token da Página**, lido com o token da conta
   (`GET /{page_id}?fields=access_token`) e usado nessa única chamada; nunca gravado, logado ou
   devolvido. Um usuário de sistema sem `pages_manage_ads` na Página recebe `rejected` **antes** de
   qualquer escrita; a campanha já criada fica `unknown`, como qualquer criação interrompida.
3. No instante em que o formulário existe (`registerLeadFormIntake`): linha em `ad_lead_forms`
   (reaproveitamento e trilha), linha em `meta_lead_forms` (a leitura periódica passa a olhar para
   ele) e a regra `lead_source_rules` `meta_form` com o funil escolhido. Uma regra já escrita à mão
   para esse id é mantida.

Conjunto: `optimization_goal: LEAD_GENERATION`, `destination_type: ON_AD`,
`promoted_object: {page_id}`. Criativo: `call_to_action.value.lead_gen_form_id` e `link` na própria
Página (`https://www.facebook.com/{page_id}/`), como nos exemplos da Meta. Tudo nasce **pausado**.

> **Não verificado ao vivo** (2026-10-06): o formato do `leadgen_forms` (tipos e chaves das perguntas,
> `privacy_policy`, `thank_you_page`, `locale`), o `link` da Página no criativo e o `promoted_object`
> do conjunto seguem a referência da Marketing API. Decisão do Eric: a criação real acontece **só em
> produção, com aprovação**; o staging fica sem token de Página e mostra a prévia. O pré-check da
> seção diz, com `no_page_token`, que a execução seria recusada.

**Permissões.** O `META_WRITE_TOKEN` (25/09) tem `ads_management`, mas não os `pages_*`. Para o
passo `lead_form` o usuário de sistema `wingstrafficwrite` precisa de **`pages_manage_ads`**,
`pages_show_list` e `pages_read_engagement`, e da Página da Wings como ativo (tarefa "Gerenciar
página"/anúncios). É o mesmo conjunto do `META_LEADS_ACCESS_TOKEN` descrito em
`docs/leads/meta-lead-ads.md`; um token com os dois conjuntos (`ads_management` + `pages_*` +
`leads_retrieval`) serviria para tudo. Quem gera é o Eric; o terminal nunca vê o valor.

## YouTube: o anúncio leva ao formulário do site

A Google diz que **Demand Gen não aceita formulário de lead** ("Lead forms are not supported in
Demand Gen" — ajuda do Google Ads, upgrade de Video Action; só Pesquisa e Performance Max). Decisão
do Eric (2026-10-06): o anúncio do YouTube leva a uma página do site `/lp/<slug>` com o formulário
padrão; Performance Max e formulário na Pesquisa ficam fora desta etapa (a Pesquisa recusou em 30/09
com `LEAD_FORM_MISSING_AGREEMENT` até aceitar os Termos na interface).

Na seção Formulário do YouTube (e, opcionalmente, da Meta com captura na página) a pessoa escolhe a
página entre as que têm o formulário do Wings System ligado (`GET /ads/lead-forms/site-pages`); o
destino vira `<origem>/lp/<slug>` e o funil mostrado é o da página.

## Formulário do site: mudança só com prévia e aprovação da Diretoria

A página `/lp/<slug>` continua a mesma; ganha, quando aprovado, o **`site_form_spec`** da regra
(múltipla escolha, política, agradecimento). O fluxo:

1. **Propor** (`POST /ads/lead-forms/site-pages/:id/propose`, `ads.request`): grava
   `site_form_spec_pending` com quem e quando; a página pública não muda.
2. **Aprovar** (`.../approve`, `ads.approve` — Admin Master e Diretoria; **nunca quem propôs**, 403
   `self_approval`): o pendente vira o que a página mostra; `site_form_approved_by/at`. **Recusar**
   (`.../reject`) descarta o pendente. Tudo em `audit_log` (`site_form.change_*`).
3. `GET /public/site-forms/:slug` devolve `form` (o aprovado, ou `null` = formulário simples); a página
   mostra a múltipla escolha antes do nome e o agradecimento aprovado. A resposta vai em
   `qualifierAnswer`, só vale se for uma das opções e fica em "Respostas do formulário" sob o texto da
   pergunta — nunca como campo de contato.

O site da Wings (wingscompany.com.br) não é tocado por este sistema.

## Prévia (desenho do sistema)

`LeadFormPreview.tsx`: Instagram **Feed, Stories e Reels** com o cartão do formulário **subindo
sobre a mídia** (transição CSS disparada por estado; respeita `prefers-reduced-motion`) e as telas
abertura → perguntas → revisão e envio (com a linha de consentimento) → agradecimento, com dados
fictícios (Ana Exemplo, Padaria Exemplo). Toca sozinha; um toque numa etapa pausa. Página do site
numa moldura de navegador. Sempre rotulada **"Desenho do Wings System"**: a prévia oficial da Meta
só existe depois que os anúncios forem criados (tela da aprovação, `/{ad_id}/previews`) e mostra o
anúncio, nunca as telas do formulário. A aprovação também mostra o formulário (onde, perguntas,
política, agradecimento) e `draftDifferences` acusa "Formulário" quando o pedido difere do rascunho.

## Dados

Migração **0074** (`0074_lead_form_in_ad`; a 0072 e a 0073 são do Opus — `_journal.json` renumerado
e `when` depois da 0073; quem fizer o último merge regenera o snapshot 0074 a partir do 0073):

- `ad_lead_forms`: `platform`, `page_id`, `fingerprint` (sha-256 do `leadFormFingerprint`), `spec`
  (sem o funil), `name`, `external_id`, `execution_id`, `created_by`.
- `lead_source_rules`: `site_form_spec`, `site_form_spec_pending`, `site_form_pending_by/at`,
  `site_form_approved_by/at`.

`wings_ro` (staging): `GRANT SELECT ON ad_lead_forms TO wings_ro;`.

## Testes

`packages/shared/src/ads/lead-form.test.ts` (mapeamento e esquema), `apps/api/src/modules/ads/
lead-form-tree.test.ts` (criação com token de Página, reaproveitamento, definição diferente = outro
formulário, token sem Página = recusa antes da escrita, campanha sem formulário inalterada),
`lead-form-routes.test.ts` (pré-check, páginas, propor/aprovar/recusar, auto-aprovação barrada,
resposta da múltipla escolha), e os blocos "the standard lead form in the ad" em
`PaidMediaBuilder.test.tsx`. Rodar os da API com `--config ../../vitest.config.ts`.
