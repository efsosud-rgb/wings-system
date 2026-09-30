# GTM-MXJLC5HH — conversão do RD observada (workspace 15, não publicado)

Aplicado em 30/09/2026 pela Tag Manager API v2 (conta 6326149608, contêiner 236411221,
workspace 15 "Default Workspace"). **Nada foi publicado**; a versão ao vivo continua a 14
("Google Ads - conversão pelo RD"). Scripts em `scripts/gtm/` (`oauth.mjs`, `dump.mjs`,
`apply.mjs`, `test-cases.mjs`); estados completos em `/root/wings-gtm/before-ws15.json` e
`after-ws15.json` (fora do repositório).

## O que a leitura do contêiner mostrou

- A tag "RD - Aviso de conversão (Wings System)" (PerformanceObserver) empurra
  `conversao_rd_station_sucesso` para **qualquer recurso** cuja URL case com
  `rdstation.com…conversions`. Isso inclui o hit do GA4 `form_start` (medição aprimorada), que
  leva `ep.form_destination=https://cta-redirect.rdstation.com/v2/conversions`. Ou seja: **o
  Lead do Pixel, a conversão do Google e o GA4 disparavam quando a pessoa começava a preencher
  o formulário**, sem envio nenhum, e também em envios recusados. Comprovado no teste: no pop-up,
  Lead disparou com zero requisições ao RD.
- O acionador "Rd form conversion" (37) é evento personalizado `conversao_rd_station_sucesso`
  com um filtro redundante (`{{Rd conversion datalayer}}`, variável de evento, contém o mesmo
  texto). Disparava: "Meta Ads - Lead Formulário" (32), "Google Ads - Enviar formulário de lead"
  (29, rótulo `iiAFCKGdq4YcEMO7i6lC`), "GA4 - lead_rd_station" (38) e a pausada "GA-4 - Envio
  formulario" (33).
- "Código de Monitoramento" (45) é só o loader do RD Station (`…-loader.js`), em All Pages.
- Os eventos `whatsapp_click`, `whatsapp_submit`, `form_start`, `form_abandonment` e
  `rdstation.form.submit` **não são empurrados por nada no site**: só existem dentro do
  contêiner. As tags de WhatsApp (16, 25, 28) e as de "Whatsapp_submit" (35, 39) nunca
  disparavam. Os links de WhatsApp são `<a href="https://wa.me/5521999470288" target="_blank">`
  do Elementor.
- Os formulários enviam por **XHR POST** para `https://cta-redirect.rdstation.com/v2/conversions`
  (formulário embutido `wings-company-form-site`; pop-up `lp-formatacao-whatsapp`). A resposta é
  observável, então o envolvimento de fetch/XHR funciona.
- O pop-up de WhatsApp é do RD (`popups.rdstation.com.br`, botão flutuante só na home); depois
  do envio aceito ele mesmo abre o WhatsApp (não é clique em link).
- Modelo do Pixel: galeria "Facebook Pixel" (facebookarchive), campo Event ID = `eventId`.

## Antes → depois (16 mudanças no workspace 15)

| Item | Antes | Depois |
| --- | --- | --- |
| Variável interna Click URL | desligada | ligada |
| Variáveis novas | — | `DLV - rd_event_id` (47), `DLV - rd_identifier` (48), `DLV - rd_status` (49), `Google Ads - RD form conversion` (50) = `rTTBCMSe24kdEMO7i6lC` |
| Acionador novo | — | `CE - rd_conversion_accepted` (51): evento personalizado igual a `rd_conversion_accepted` |
| Acionador novo | — | `Click - WhatsApp (wa.me)` (52): clique em link, Click URL casa `wa\.me\|api\.whatsapp\.com\|web\.whatsapp\.com`, aguarda tags 2 s |
| Tag nova | — | `HTML - RD conversão observada` (53), Initialization - All Pages, uma vez por página, código de `docs/gtm/rd-conversao-observada.html` |
| RD - Aviso de conversão (Wings System) (46) | ativa, All Pages | **pausada** (nota explica) |
| Meta Ads - Lead Formulário (32) | acionador 37 | acionador 51; Event ID = `{{DLV - rd_event_id}}` |
| Google Ads - Enviar formulário de lead (29) | acionador 37; rótulo `iiAFCKGdq4YcEMO7i6lC`; sem transaction id | acionador 51; rótulo `{{Google Ads - RD form conversion}}` (`rTTB…`); Transaction ID = `{{DLV - rd_event_id}}` |
| GA4 - lead_rd_station (38) | acionador 37 | acionador 51; parâmetros `rd_identifier` e `rd_event_id` |
| GA-4 - Envio formulario (33, pausada) | acionador 37 | acionador 51 (segue pausada) |
| Meta Ads - WhatsApp_clique (28) | evento personalizado `whatsapp_clique`, acionador 13 (morto) | evento padrão **Contact**, acionador 52 |
| Google Ads - WhatsApp_clique (25) | acionador 13 (morto) | acionador 52 (rótulo `NsLa…` mantido) |
| GA4 - Evento WhatsApp_click (16) | acionador 13 (morto) | acionador 52 |

Sem mudança: acionadores 13 e 37 ficaram no contêiner sem uso (podem ser apagados depois);
tags 4, 7, 14, 15, 20, 23, 35, 39, 45 intocadas; a variável 27 (`iiAF…`) fica sem uso.

A tag observadora ganhou uma correção em relação ao commit `c76694c`: a URL do RD é casada
pelo **host e pelo caminho**, nunca pela query, para um hit do GA4 que carrega o endereço do RD
como parâmetro não contar.

## Regra final

| Caso | Evento no dataLayer | Dispara |
| --- | --- | --- |
| Formulário aceito pelo RD (2xx), qualquer identificador, inclusive `lp-formatacao-whatsapp` | `rd_conversion_accepted` | Pixel **Lead** (Event ID), Google Ads `rTTB…` (Transaction ID), GA4 `lead_rd_station` |
| Envio recusado (não 2xx ou rede) | `rd_conversion_refused` | nada |
| Envio por sendBeacon (sem resposta) | `rd_conversion_unknown` | nada |
| Clique solto em link do WhatsApp | clique em link (`gtm.linkClick`) | Pixel **Contact**, Google Ads `NsLa…`, GA4 `whatsapp_click` |

## Testes (30/09/2026, Chromium headless, site real, RD interceptado)

`node scripts/gtm/test-cases.mjs --container live --inject`: contêiner **ao vivo** (versão 14)
com a tag nova injetada na inicialização; a requisição do RD é respondida localmente (200 ou 422)
e nenhum dado chega ao RD; o WhatsApp nunca abre. Dados fictícios.

| Caso | Requisição do RD vista | Evento novo no dataLayer | O que o contêiner ao vivo disparou (o bug) |
| --- | --- | --- | --- |
| 1 formulário aceito (200) | XHR POST `cta-redirect.rdstation.com`, `wings-company-form-site` | `rd_conversion_accepted`, status 200, `rd_event_id` UUID | Lead, Google `iiAF…`, GA4 `lead_rd_station` |
| 2 envio recusado (422) | idem, respondido 422 | `rd_conversion_refused`, status 422 | Lead, Google `iiAF…`, GA4 `lead_rd_station` (indevidos) |
| 3 pop-up aceito (200) | XHR POST, `lp-formatacao-whatsapp` | `rd_conversion_accepted` | Lead e Google dispararam **antes** da requisição (pelo `form_start` do GA4) |
| 4 clique solto no WhatsApp | nenhuma | nenhum evento `rd_*` | só o `click` da medição aprimorada do GA4; nada do Pixel/Google |

**Pendente:** os mesmos 4 casos com o **rascunho** servido no navegador (quais tags disparam
com o novo encadeamento). Com os escopos concedidos (`edit.containers` + `readonly`) a API
recusa `quick_preview`, `create_version` e `environments.reauthorize` (403 "insufficient
authentication scopes"); o ambiente de preview do workspace (22) serve uma foto de 14/12/2025.
Precisa de um consentimento com `tagmanager.edit.containerversions` para compilar
(`quick_preview`) e criar uma **versão sem publicar**, que o ambiente "Latest" serve.
