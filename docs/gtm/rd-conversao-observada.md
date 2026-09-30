# GTM-MXJLC5HH — conversão do RD observada (versão 17, não publicada)

Aplicado em 30/09/2026 pela Tag Manager API v2 (conta 6326149608, contêiner 236411221),
primeiro no workspace 15, depois consolidado na **versão 17** ("RD conversão observada
(30/09/2026) — não publicada"). **Nada foi publicado**: a versão ao vivo continua a 14
("Google Ads - conversão pelo RD"). As versões 15 e 16 (tentativas intermediárias) foram
apagadas. Criar a versão fecha o workspace: o Default Workspace atual é o 18, igual à 17.
Scripts em `scripts/gtm/` (`oauth.mjs`, `api.mjs`, `dump.mjs`, `apply.mjs`,
`test-cases.mjs`); estados completos em `/root/wings-gtm/before-ws15.json` e
`after-v17-ws18.json` (fora do repositório).

Publicar: <https://tagmanager.google.com/#/versions/accounts/6326149608/containers/236411221/versions/17>
(ação "Publicar" da versão 17).

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

## Antes → depois (versão 14 → versão 17)

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

Depois disso: variáveis DLV com `dataLayerVersion` inteiro; "GA4 - Evento WhatsApp_click" com nome literal `whatsapp_click`; gancho do XHR no `open()`. Sem mudança: acionadores 13 e 37 ficaram no contêiner sem uso (podem ser apagados depois);
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

## Três coisas que o compilador e o navegador ensinaram

- O compilador do GTM recusa (`compilerError`, sem mensagem) **declarações `function` dentro de
  bloco** (`try {}`) e **vírgula final em argumentos de chamada**: ES5 estrito. As funções
  internas viraram `var x = function`. Conferido com acorn (`ecmaVersion: 5`, `"use strict"`).
- Variável da camada de dados: `dataLayerVersion` tem de ser `type: integer`; como `template`
  a variável compila mas resolve `false` (Event ID e Transaction ID saíam vazios na versão 15).
- "GA4 - Evento WhatsApp_click" tinha o nome do evento numa variável da camada de dados que não
  existe num clique em link (chegava `undefined` no GA4); virou o literal `whatsapp_click`.

## Testes (30/09/2026, Chromium headless, site real, RD interceptado)

`node scripts/gtm/test-cases.mjs --container env:2 --dialogdelay 1000`: o contêiner da
**versão 17** servido pelo ambiente "Latest" (o `gtm.js` do site é trocado por ele), a
requisição do RD respondida localmente (200 ou 422) sem nenhum dado chegar ao RD, o WhatsApp
nunca abre, o alerta "Obrigado!" fica 1 s aberto como para uma pessoa. Dados fictícios.
Relatório: `/root/wings-gtm/report-draft-v17.json`.

| Caso | RD | Evento novo | Pixel | Google Ads | GA4 |
| --- | --- | --- | --- | --- | --- |
| 1 formulário aceito (200) | XHR `wings-company-form-site` | `rd_conversion_accepted` | **Lead** 1×, `eid` = rd_event_id | **rTTB…** 1×, `oid` = rd_event_id | `lead_rd_station` **não chegou** (ver abaixo) |
| 2 envio recusado (422) | XHR, 422 | `rd_conversion_refused` | nada | nada | nada |
| 3 pop-up aceito (200) | XHR `lp-formatacao-whatsapp` | `rd_conversion_accepted` | **Lead** 1×, `eid` | **rTTB…** 1×, `oid` | `lead_rd_station` 1× com `rd_identifier` e `rd_event_id` |
| 4 clique solto no WhatsApp | nenhuma | nenhum | **Contact** 1× | `NsLa…` 1× | `whatsapp_click` 1× |

Nota: cada conversão do Google Ads aparece como duas requisições (doubleclick + google.com,
uma com `oid`); é uma conversão. O "Lead antes da requisição" da tag antiga não acontece mais.

**GA4 no caso 1.** O RD, no sucesso do formulário embutido, mostra `alert("Obrigado!")` e
em seguida faz `location.href = redirect_to` (redirecionamento legado do formulário, para a
própria home). A tag GA4 dispara (sem o redirecionamento o `lead_rd_station` chega: teste
`--noredirect`), mas o gtag segura o evento por ~5 s para agrupar (medido: 4,93–4,95 s, também
no caso 3) e a página troca ~1 s depois do alerta; no headless o envio no `pagehide` não
apareceu. Pixel e Google saem na hora e não sofrem. Correção fora do GTM: no RD Station,
trocar o redirecionamento do formulário `wings-company-form-site` por mensagem na página (ou
por uma página de obrigado). O contêiner ao vivo tem o mesmo problema.

**Preexistente, fora do pedido:** o GA4 recebe eventos chamados `undefined` (3 por
formulário) porque "GA4 - Evento Form_start" e "Form_abort" usam variáveis da camada de dados
que não existem; e a medição aprimorada do GA4 (`form_start`, `form_submit`) alimenta
acionadores de evento personalizado com o mesmo nome. Vale limpar noutra onda.

## Testes anteriores (contêiner ao vivo, versão 14, tag nova injetada)

`--container live --inject` mostrou o bug da versão 14: Lead, Google `iiAF…` e GA4 disparavam
no caso 2 (recusado) e, no caso 3, **antes** da requisição ao RD, pelo `form_start` do GA4.
Relatórios `report-live-inject*.json`.
