# API de Conversões da Meta (evento Lead pelo servidor)

É a principal recomendação da Meta para a conta da Wings. Hoje o Lead do site chega à Meta só pelo
navegador (o pixel no GTM), e bloqueadores de anúncio e o iOS escondem parte deles. Com a API de
Conversões, o servidor também envia o Lead, e a Meta junta os dois pelo mesmo id de evento.

**Está pronta e desligada.** Só o Eric liga. Nenhum envio real foi feito no desenvolvimento: os
testes usam uma Meta de mentira.

## Como funciona

1. A pessoa envia o formulário do site (`POST /public/site-forms/:slug`). O consentimento é
   obrigatório ali, e o lead é gravado com `legal_basis = 'consent'`, a hora e o texto que a
   pessoa aceitou.
2. Com `META_CAPI_ENABLED=true` na API, ela põe um job `meta_capi_lead` na fila, com o id do
   lead, um id de evento novo (`lead-<uuid>`), a hora, o user agent do navegador e a página. Nada
   de e-mail, telefone ou nome no job. A API devolve o id de evento à página, que o coloca no
   `lead_submit` do dataLayer como `event_id`.
3. O worker (`apps/worker/src/jobs/meta-capi-lead.ts`), com `META_CAPI_ENABLED=true` no worker,
   lê o lead e só envia se a base legal for consentimento com a hora gravada. Envia à Meta:
   - e-mail e telefone **com hash SHA-256** (e-mail em minúsculas sem espaços; telefone só dígitos
     com 55);
   - o id do lead com hash, como `external_id`;
   - `fbc`, montado com o `fbclid` da visita quando houve clique em anúncio (a Meta pede sem hash);
   - o user agent (obrigatório para evento de site).
     Não vão nome, IP, CPF, empresa nem respostas do formulário.
4. O token vai num cabeçalho, nunca na URL nem no log. Erro da Meta vira só o código
   (`meta_capi_http_400 code=100 subcode=…`), porque a mensagem dela pode citar o que foi enviado.
   Uma nova tentativa é segura: a Meta descarta um id de evento repetido. Evento com mais de 7 dias
   não é enviado (a Meta recusa).

## Variáveis

| Onde   | Variável                    | O que é                                                                            |
| ------ | --------------------------- | ---------------------------------------------------------------------------------- |
| API    | `META_CAPI_ENABLED`         | `true` põe o job na fila. Vazio ou `false`: nada muda no formulário                |
| Worker | `META_CAPI_ENABLED`         | `true` envia. Sem ela o job termina como `disabled`                                |
| Worker | `META_PIXEL_ID`             | O mesmo pixel da API (`1116678872845520`). Não é segredo                           |
| Worker | `META_CAPI_ACCESS_TOKEN`    | Token gerado no Gerenciador de Eventos para esse pixel. **Segredo**: só no Coolify |
| Worker | `META_CAPI_TEST_EVENT_CODE` | Código de "Testar eventos". Com ele, os eventos aparecem só no teste               |

Se `WORKER_JOB_TYPES` estiver definida no worker, inclua `meta_capi_lead`.

## Para o Eric ligar (staging primeiro)

1. **Jurídico/LGPD:** confirmar que o texto de consentimento do formulário cobre o
   compartilhamento com a Meta para medir anúncios. Sem isso, não ligue.
2. No Gerenciador de Eventos da Meta, pixel `1116678872845520` → Configurações → API de
   Conversões → **Gerar token de acesso**. Guardar o token só no Coolify do worker
   (`META_CAPI_ACCESS_TOKEN`).
3. Em "Testar eventos", copiar o código de teste para `META_CAPI_TEST_EVENT_CODE` no worker.
4. Ligar `META_CAPI_ENABLED=true` na API e no worker de **staging**; fazer o deploy de staging.
5. Enviar um formulário de teste e ver o Lead em "Testar eventos" (deve aparecer como "Servidor").
   Na tela Wings Ads Intelligence → Visão geral, o card "API de Conversões" mostra enviados e
   falhas.
6. **Deduplicação no GTM:** na tag do pixel que dispara o Lead, preencher "Event ID" com a variável
   de dataLayer `event_id`. Sem isso, a Meta conta o mesmo lead duas vezes (navegador e servidor).
7. Conferido o teste, apagar `META_CAPI_TEST_EVENT_CODE` para os eventos contarem de verdade.
8. Produção só depois, com o deploy de produção que o Eric libera (PRODUCAO).

## O que fica de fora

- Leads de formulário instantâneo da Meta (Lead Ads) já nascem na Meta; enviá-los de volta com a
  etapa do CRM ("Conversion Leads") é outra integração, não feita aqui.
- Nome, cidade e IP melhorariam a correspondência (Event Match Quality), mas ficaram de fora por
  minimização de dados. Decisão do Eric com o Jurídico se quiser incluir.
- Nada foi verificado contra a Meta real: o formato segue a documentação pública da API de
  Conversões (Graph API v23.0, `/{pixel}/events`) e está marcado como **não verificado** até o
  primeiro teste em staging.
