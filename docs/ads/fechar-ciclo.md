# Fechar o ciclo — etapas do CRM de volta para a Meta e o Google

Plano de 13/10/2026, atualizado em 02/11/2026 (t085). **Construído e desligado.** Nada foi enviado:
os testes usam uma Meta e um Google de mentira, e a trava sem rede (`no-network.ts`) impede chamada
real. Nenhuma conta de anúncio, dataset, ação de conversão ou token foi criado ou mudado.

Ordem do Eric (13/10, reforçada em 30/10): devolver à Meta e ao Google os leads que chegam a
**Reunião agendada**, **Reunião realizada**, **Proposta enviada** e **COF**. Hoje as plataformas só
sabem que alguém preencheu um formulário. Com as etapas, a campanha passa a ser medida por reunião e
proposta, e a Meta pode entregar o anúncio a quem tem mais chance de virar reunião.

## Resumo

- **Meta, formulário instantâneo:** a integração de CRM da API de Conversões, com o `lead_id` da Meta
  (sem hash). É o caminho mais forte e o único que a Meta usa para otimizar a entrega.
- **Meta, leads do site:** `fbc` e `fbp` (cookies do pixel, agora guardados na entrada). E-mail e
  telefone com hash só com a chave própria `CRM_CONVERSIONS_HASHED_ENABLED`, depois do Jurídico.
- **Google:** a porta é a **Data Manager API** (`events:ingest`), sem developer token. O
  `UploadClickConversions` está fechado para nós desde 15/06/2026.
- **Lacuna do `gcl_id` fechada:** o formulário de lead do Google agora grava o GCLID.
- **Uma linha por lead, etapa e plataforma**, na fila de saída `ad_conversion_sends`, escrita antes da
  chamada. Repetir não duplica.
- **Tudo desligado:** uma chave por plataforma, uma data de corte obrigatória, o hash numa chave à
  parte, e o Google só valida (`validateOnly`) até o Eric mandar gravar.
- **LGPD:** a Política de Privacidade ainda não existe e os textos de consentimento falam só de
  contato. Recomendação: **não** ligar o envio com hash antes disso (seção 4).

## 0. As etapas, no nosso banco

- As etapas não estão fixas no código. Vêm do RD (`ensureStage`), uma lista por funil (`expansao`,
  `formatacao`, `consultoria`), em `crm_stages`. Um gestor renomeia, reordena e cria etapas em
  Administração → CRM.
- "COF" não aparece como nome de etapa no código. No repositório, COF é a **Circular de Oferta de
  Franquia**, e o BI conta o marco "COF enviada". Qual etapa de cada funil é a COF: decisão do Eric,
  na tela (ver DUVIDAS da t085).
- **A ligação é pelo id da etapa, nunca pelo nome:** a tabela `ad_conversion_stage_events` diz "esta
  etapa = este evento nesta plataforma" (e, no Google, "esta ação de conversão"). Renomear a etapa
  não muda nada nem reenvia nada. Quem tem `ads.approve` escolhe na tela (seção 9).
- **A fonte é `lead_stage_history`** (só acrescenta linhas). O evento é a **primeira** entrada do
  lead na etapa, venha de onde vier. Voltar e entrar de novo não conta.
- Só valem mudanças feitas aqui (`source` `wings` ou `sofia`). Mudanças de `import` (carga do RD) e
  `rd` (espelho de hora em hora) **não** são enviadas: a hora delas não é o momento real.

## 1. O que guardamos na entrada do lead

Tabela `lead_ad_identifiers`: um identificador por linha, com **a porta** (`source`, a origem daquela
chegada) e **a data** (`captured_at`, o momento em que a pessoa trouxe o identificador: o envio do
formulário, o `created_time` da Meta). Quem volta por outro anúncio fica com os dois. A gravação
acontece dentro da transação do `upsertLead`, então vale para todas as portas que passam por ele.

| Tipo           | De onde vem                                                                  | Portas que gravam            |
| -------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| `meta_lead_id` | o `leadgen_id` do formulário instantâneo (15 a 17 dígitos)                   | `meta_lead_ads`              |
| `fbclid`       | parâmetro do endereço; primeiro toque guardado no navegador                  | site (fale, embed), RD       |
| `fbc`          | cookie `_fbc` do pixel; sem ele, `fb.1.<ms do 1º clique>.<fbclid>` na página | site (fale, embed)           |
| `fbp`          | cookie `_fbp` do pixel                                                       | site (fale, embed)           |
| `gclid`        | parâmetro do endereço; `gcl_id` do webhook do formulário do Google           | site, RD, `google_lead_form` |
| `gbraid`       | parâmetro do endereço (iOS)                                                  | site, RD                     |
| `wbraid`       | parâmetro do endereço (web → app)                                            | site, RD                     |

- Valor fora do formato da plataforma é descartado em silêncio (`ad-identifiers.ts`).
- **Nunca em log:** a rota do formulário registra só o formato do corpo (`shapeOf`: nomes de campo e
  tamanhos); os identificadores não vão para auditoria, linha do tempo, relatório ou dw. A tabela
  **não** tem `GRANT` para `wings_ro`.
- Importação e espelho do RD (`importBatchId`, `rd_crm`) não gravam. Leads antigos continuam com o
  primeiro toque nas colunas `leads.gclid/fbclid/gbraid/wbraid`, e o envio também lê essas colunas
  (com a data de entrada do lead).
- `fbc` e `fbp` saem dos cookies no `trackingPayloadOf` (`apps/landing/src/lib/tracking.ts`); nunca
  do endereço. No formulário embutido em outro site, o navegador pode esconder os cookies: aí só vale
  o `fbclid`.

## 2. Meta — API de Conversões, integração de CRM

`POST https://graph.facebook.com/v26.0/<DATASET_ID>/events`, um evento por pedido (a Meta recusa o
lote inteiro se um evento passar de 7 dias; um por pedido isola o erro). Token no cabeçalho
`Authorization`, nunca no endereço.

| Campo                           | Valor                                                              |
| ------------------------------- | ------------------------------------------------------------------ |
| `event_name`                    | o nome configurado para a etapa (ex.: `reuniao_agendada`)          |
| `event_time`                    | Unix em segundos: a primeira entrada na etapa                      |
| `event_id`                      | o id da linha da fila (`ad_conversion_sends.id`); sem dado pessoal |
| `action_source`                 | `system_generated`                                                 |
| `custom_data.event_source`      | `crm`                                                              |
| `custom_data.lead_event_source` | `Wings System`                                                     |
| `user_data`                     | um dos três caminhos abaixo                                        |

**Caminhos de identificação, em ordem:**

1. `lead_id` (formulário instantâneo): número inteiro, **sem hash**. Vai como número no JSON, montado
   do texto para não perder dígitos.
2. `fbc` e/ou `fbp`, sem hash.
3. Só com `CRM_CONVERSIONS_HASHED_ENABLED=true` **e** lead com `legal_basis = 'consent'`: `em`, `ph`
   e `external_id` (o id do lead), todos com hash.

Sem nada disso, a linha fica `skipped` com o motivo `no_identifier`. O caminho 1 é o que a Meta usa
para otimizar ("Conversion Leads": 200 leads/mês ou mais, etapa em até 28 dias do lead, conversão
entre 1% e 40%, envio ao menos 1×/dia). Os caminhos 2 e 3 medem e alimentam públicos.

- `event_time` precisa ser depois da entrada do lead, senão a Meta pode descartar: a linha fica
  `skipped` com `before_lead`.
- `test_event_code` (`CRM_CONVERSIONS_META_TEST_EVENT_CODE`) mostra os eventos em "Testar eventos",
  mas **não é ensaio**: "Events sent with `test_event_code` are not dropped. They flow into Events
  Manager and are used for targeting and ads measurement purposes" (página de uso da API, lida em
  02/11/2026). Por isso um evento com o código fica `sent` e **nunca é reenviado** sem ele (reenviar
  poderia contar a etapa duas vezes). O painel avisa quando o código está ligado. Use-o só numa etapa
  e num evento de teste (seção 10).
- Repetição com o mesmo `event_id`: a página de uso da API diz "if we receive the same `event_id`
  and `event_name` more than once, we keep only the first copy"; a de deduplicação limita isso a
  48 horas. Como a garantia tem prazo e não foi conferida na conta, seguimos no lado seguro: um pedido
  que pode ter chegado (tempo esgotado, conexão perdida no meio) **não** é repetido; fica `failed`
  com o código, para uma pessoa conferir no Gerenciador de Eventos.
- O pixel do site já manda `Lead` do navegador; o servidor não manda `Lead` (as etapas são outros
  eventos e não colidem).

## 3. Google — Data Manager API

`POST https://datamanager.googleapis.com/v1/events:ingest`, um evento por pedido (um evento com
campo obrigatório inválido derruba o pedido inteiro). Escopo OAuth
`https://www.googleapis.com/auth/datamanager`; **sem developer token**.

```json
{
  "destinations": [
    {
      "operatingAccount": { "accountType": "GOOGLE_ADS", "accountId": "<conta>" },
      "productDestinationId": "<id da ação de conversão>"
    }
  ],
  "encoding": "HEX",
  "validateOnly": true,
  "events": [
    {
      "transactionId": "<id da linha>",
      "eventTimestamp": "<ISO>",
      "eventSource": "OTHER",
      "adIdentifiers": { "gclid": "…" },
      "userData": { "userIdentifiers": [{ "emailAddress": "<hash>" }, { "phoneNumber": "<hash>" }] }
    }
  ]
}
```

- A ação de conversão é do tipo `UPLOAD_CLICKS` ("conversões de cliques"), criada por uma pessoa no
  Google Ads; o id vai na configuração da etapa. Esperar **6 horas** depois de criar antes do 1º envio.
- `transactionId` = id da linha. O Google **deduplica por `transactionId`** dentro da ação: repetir é
  seguro, então falha temporária e tempo esgotado voltam para a fila.
- `validateOnly` fica `true` até `CRM_CONVERSIONS_GOOGLE_VALIDATE_ONLY=false`: o Google confere o
  formato e não grava nada. A linha validada fica `validated` (não conta como enviada nem como
  "último envio"). Quando a validação é desligada, as linhas `validated` voltam para a fila
  (`pending`, tentativas zeradas) e vão de verdade com o mesmo `transactionId`, desde que ainda no
  prazo de 90 dias.
- `eventSource`: obrigatório para conversão offline; a documentação não diz qual valor serve para
  etapa de CRM. Usamos `OTHER` (**não verificado**). `accountType: GOOGLE_ADS`: **não verificado**.
- Consentimento (`consent`): **não enviamos** enquanto o texto de consentimento não cobrir anúncio.
  Mandar `CONSENT_GRANTED` hoje seria afirmar um consentimento que a pessoa não deu.
- Prazos: GCLID até **90 dias** depois do clique; só com hash, **63 dias**. Fora disso, `skipped` com
  `expired`.
- Diagnóstico: `RetrieveRequestStatus` com o `requestId` (guardado em `platform_request_id`), depois
  de 30 minutos e até 24 horas. Não vale para `validateOnly`.

## 4. O que vai com hash, e como é normalizado

O hash (SHA-256, em hexadecimal minúsculo) é feito **na hora do envio, em memória**
(`crm-conversions-hash.ts`). Nunca é gravado em tabela, log, resposta ou relatório; a linha da fila
guarda só os **nomes** dos campos enviados (`fields_sent`). Só com a chave do hash ligada.

| Dado     | Meta (`em`, `ph`)                                           | Google (`emailAddress`, `phoneNumber`)                                                             |
| -------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| E-mail   | sem espaços nas pontas, minúsculas                          | sem espaço nenhum, minúsculas; em gmail.com e googlemail.com, sem pontos e sem o `+…` antes do `@` |
| Telefone | só dígitos, com o código do país (55), sem zeros à esquerda | E.164: `+55…`                                                                                      |
| Lead     | `external_id` = hash do id do lead (recomendado pela Meta)  | —                                                                                                  |

Sem hash: `lead_id`, `fbc`, `fbp` (Meta) e `gclid`, `gbraid`, `wbraid` (Google), como as plataformas
pedem. Não vão nome, cidade, IP, navegador, CPF, empresa ou respostas do formulário.

## 5. Como o envio funciona

Código: `apps/api/src/modules/ads/crm-conversions.ts` (ciclo), `crm-conversions-clients.ts` (os dois
pedidos), `crm-conversions-status.ts` (painel). Roda **dentro da API**, a cada 5 minutos, só se uma
das chaves estiver ligada; o token não sai da API.

1. **Fila:** para cada plataforma pronta (chave ligada, configuração completa, data de corte), uma
   linha em `ad_conversion_sends` para cada primeira entrada de lead numa etapa configurada, desde
   `CRM_CONVERSIONS_SINCE` e dentro do prazo (Meta 7 dias, Google 90). Chave única
   `lead_id + stage_id + platform`: a mesma etapa nunca gera duas linhas, mesmo com dois ciclos
   juntos.
2. **Envio:** pega as linhas devidas com `FOR UPDATE SKIP LOCKED`, confere as travas, monta o evento
   e chama a plataforma uma vez. Travas, nesta ordem, cada uma encerra a linha sem chamada:
   "não me contate" por qualquer chave da pessoa (`opt_out`), etapa antes da entrada (`before_lead`),
   prazo (`expired`), sem identificador (`no_identifier`).
3. **Resultado:**
   - `sent`: guarda o id do pedido (`fbtrace_id` / `requestId`) e o formato da resposta (`shapeOf`).
   - `validated`: o Google respondeu 200 a um pedido com `validateOnly`. Nada foi gravado; volta para
     a fila quando `CRM_CONVERSIONS_GOOGLE_VALIDATE_ONLY=false`.
   - **volta para a fila** (`pending`, com espera de 5 min dobrando até 6 h): HTTP 429 ou 5xx, rede
     que nem chegou a conectar; no Google também tempo esgotado. Até **6 tentativas**, depois `failed`.
   - `failed`: recusa da plataforma (4xx), ou, na Meta, um pedido que pode ter chegado.
   - Uma linha presa em `sending` por mais de 15 min (processo caiu): Google volta para a fila, Meta
     fica `failed` com `worker_lost`.
   - Sem token do Google, nenhuma linha é pega e nenhuma tentativa é gasta.
   - **Credencial recusada** no meio do lote (HTTP 401 ou 403, ou o código 190 da Meta, de token
     vencido ou revogado): o lote inteiro volta para a fila como estava, sem gastar tentativa, e o
     ciclo para. As linhas esperam alguém trocar o token; as que passarem do prazo viram `expired`.
4. **Registro:** a linha nunca é apagada pelo ciclo. Guarda tentativas, último código de erro, motivo
   do descarte, nomes dos campos, id do pedido. Logs: só contagens e códigos.
5. **Apagar um lead (expurgo LGPD, futuro):** `ad_conversion_sends` e `lead_ad_identifiers` apontam
   para `leads` (e a fila para `lead_stage_history`) sem `ON DELETE`. Quem apagar um lead precisa
   apagar antes as linhas dessas duas tabelas. Hoje só o desfazer da importação do RD apaga leads, e
   ele já limpa `lead_ad_identifiers` (lead de importação nunca entra na fila).

Leads nunca enviados: origem `manual`, `csv_import`, `google_places`, `instagram_colagem` e qualquer
lead de importação (`import_batch_id`).

## 6. Variáveis (todas na API; segredos só no Coolify)

| Variável                               | O que é                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `CRM_CONVERSIONS_META_ENABLED`         | `true` liga a Meta. Vazio ou `false`: nada entra na fila, nada sai                              |
| `CRM_CONVERSIONS_GOOGLE_ENABLED`       | o mesmo, para o Google                                                                          |
| `CRM_CONVERSIONS_SINCE`                | dia de corte (AAAA-MM-DD, Brasília). Sem ele, nada é enviado                                    |
| `CRM_CONVERSIONS_HASHED_ENABLED`       | `true` permite e-mail e telefone com hash (depois do Jurídico)                                  |
| `CRM_CONVERSIONS_GOOGLE_VALIDATE_ONLY` | o Google só valida, a menos que seja `false`                                                    |
| `CRM_CONVERSIONS_META_DATASET_ID`      | o dataset (pixel) que recebe os eventos de CRM. Não é segredo                                   |
| `META_CAPI_TOKEN`                      | token do dataset, gerado no Gerenciador de Eventos. **Segredo**                                 |
| `CRM_CONVERSIONS_META_TEST_EVENT_CODE` | código de "Testar eventos"                                                                      |
| `CRM_CONVERSIONS_GOOGLE_REFRESH_TOKEN` | autorização com o escopo da Data Manager, no cliente `GOOGLE_ADS_CLIENT_ID/SECRET`. **Segredo** |
| `GOOGLE_ADS_CUSTOMER_ID`               | a conta de anúncios (já existe)                                                                 |

Essas chaves não têm relação com `ADS_WRITES_ENABLED` nem com a trava das contas: não mexem em
campanha, conjunto, anúncio ou verba.

## 7. LGPD — para o Jurídico

Hash é **pseudonimização, não anonimização**: a plataforma usa o hash justamente para achar a pessoa.
Continua sendo dado pessoal. O `lead_id` da Meta e os ids de clique também identificam a pessoa
dentro da plataforma.

**Base legal (proposta técnica, a confirmar pelo Jurídico):**

- Leads do **formulário instantâneo da Meta** e do **formulário do Google**: o dado nasceu na própria
  plataforma; devolver a etapa com o id dela é o caso de uso previsto pelas duas. Base provável:
  legítimo interesse (art. 7º, IX), com teste de balanceamento, ou consentimento se o texto do
  formulário cobrir.
- Leads do **site** com `fbc`/`fbp`/GCLID: cookies de anúncio. Precisam do aviso de cookies e da
  Política; base provável: consentimento (cookies) ou legítimo interesse.
- **E-mail e telefone com hash**: hoje os textos gravados (`SITE_FORM_CONSENT_TEXT`, `consent_text`)
  autorizam só contato por telefone, WhatsApp e e-mail. **Não cobrem** medição de anúncios. Por isso
  a chave do hash fica desligada e, mesmo ligada, só vale para lead com `legal_basis = 'consent'`.

**O que a Política de Privacidade precisa dizer, no mínimo:**

1. **Finalidade:** medir e melhorar anúncios, informando à Meta e ao Google quais contatos viraram
   reunião, proposta ou COF.
2. **Base legal** de cada caso acima.
3. **Quem recebe:** Meta Platforms e Google, nomeados.
4. **Transferência internacional:** as duas tratam dados fora do Brasil (arts. 33 a 36 da LGPD;
   Resolução CD/ANPD nº 19/2024, cláusulas-padrão).
5. **O que vai:** ids de lead e de clique, cookies do pixel, a etapa e a data; e-mail e telefone com
   hash, se ligado. Dizer que hash não é anonimização.
6. **Retenção:** guardamos o registro de envio (`ad_conversion_sends`: ids e códigos) e os
   identificadores pelo tempo do lead; e o que as plataformas dizem guardar.
7. **Direitos do titular** (art. 18) e **como se opor**. Hoje o "não me contate" do CRM, por qualquer
   chave da pessoa, já bloqueia o envio (`opt_out`). Uma marca só de "não usar meus dados em
   anúncios" ainda não existe.
8. **Controlador** e contato do **encarregado** (DPO).

- Recomendado: o texto de consentimento dos formulários (site, Meta, Google) passa a citar a medição
  de anúncios e apontar para a Política. Depois disso, o Google pode receber `consent` preenchido.
- Os formulários da Meta e do Google já exigem um link de política: conferir para onde apontam.
- Leads de **Expansão** são candidatos à franquia de uma marca: quem é o controlador (a marca ou a
  Wings) muda quem precisa da política e do consentimento.

> ⚠️ Esta lista é técnica, não parecer jurídico. **O Jurídico revisa** a base legal, a política, o
> texto de consentimento e a transferência internacional antes de qualquer envio.

## 8. Prazos

| Plataforma | Regra                                                               | Prazo           |
| ---------- | ------------------------------------------------------------------- | --------------- |
| Meta       | `event_time` no passado, na hora do envio (um velho derruba o lote) | até 7 dias      |
| Meta       | etapa que a Meta otimiza, contada do lead                           | até 28 dias     |
| Meta       | frequência de envio                                                 | ao menos 1×/dia |
| Google     | conversão com GCLID, contada do clique                              | até 90 dias     |
| Google     | conversão só com dado com hash                                      | até 63 dias     |
| Google     | ação de conversão nova antes do primeiro envio                      | esperar 6 horas |
| Google     | frequência para os lances automáticos                               | ao menos 1×/dia |

- **Meta:** a COF ainda pode ir, se for enviada até 7 dias depois da mudança de etapa (o ciclo de
  5 minutos resolve). Para otimização, o alvo realista é **Reunião agendada** (até 28 dias do lead).
- **Google:** COF tardia pode passar dos 90 dias do clique. Medir antes os dias do lead até cada etapa
  (o BI tem os marcos em `dw.fato_negociacao`).

## 9. O painel

Marketing → Agente de Tráfego Pago — Wings → **Etapas do CRM** (`/marketing/trafego-pago-wings/conversoes`).

- Quem tem `ads.read` vê, por plataforma e nos últimos 30 dias: enviados, só validados (Google), na fila, falharam,
  não enviados; falhas por código (`http_400:100`, `timeout`…); descartes por motivo; o último envio;
  e o que falta configurar, pelo nome da variável. Só contagens e códigos: nenhum lead, nenhum id,
  nenhum hash (`GET /ads/conversions`).
- Quem tem `ads.approve` (Admin Master, Diretoria) escolhe qual etapa vira qual evento
  (`PUT /ads/conversions/mappings`, auditado como `ad_conversion.mapping_saved`). Nenhuma rota liga
  as chaves: elas são variáveis de ambiente, do Eric.

## 10. Como testar

Não há conta de teste. **Todo teste real toca a conta real** e só acontece com ordem do Eric.

- **Nosso código:** `crm-conversions.test.ts`, `crm-conversions-guards.test.ts` (cada trava sozinha,
  validação do Google seguida de gravação, credencial recusada), `crm-conversions-hash.test.ts`,
  `crm-conversions-routes.test.ts`, `ad-identifiers.test.ts`, `site-forms.test.ts` (captura),
  `tracking.test.ts` (landing) e `AdConversionsPage.test.tsx`, com plataformas falsas e a trava sem rede.
- **Meta:** "Testar eventos" com `CRM_CONVERSIONS_META_TEST_EVENT_CODE`. A Meta diz que esses eventos
  entram no Gerenciador para público e medição: usar um evento só de teste (ex.: `teste_wings`) numa
  etapa de teste. O que sai com o código conta como enviado e não é reenviado depois. Um `lead_id` inventado é recusado; o caminho é um funcionário preencher um
  formulário real, com o consentimento dele.
- **Google:** primeiro com `validateOnly` (o padrão). Depois, uma ação de conversão **de teste,
  secundária** (não entra nos lances), com um GCLID real; conferir pelo `RetrieveRequestStatus` e no
  diagnóstico da ação.
- Ordem: Google `validateOnly` → um lead real na ação de teste → uma semana olhando os diagnósticos →
  só então as ações reais.

## 11. Como desligar

- **Chave da plataforma** em `false` (ou vazia): nada entra na fila e nada sai. Linhas que estavam na
  fila esperam; ao religar, as que passaram do prazo viram `expired`.
- **Data de corte:** ao religar depois de uma pausa, mover `CRM_CONVERSIONS_SINCE` evita a enxurrada.
- **Na Meta:** desconectar a integração de CRM no Gerenciador de Eventos, ou revogar o token.
- **No Google:** tornar a ação secundária ou removê-la; revogar a autorização da Data Manager.
- **O que já foi enviado não volta.** Na Meta, apagar evento enviado: não verificado. No Google existe
  ajuste de conversão pela Data Manager; não implementado.

## 12. O RD

O RD pode já mandar eventos próprios (integração "API de Conversões" com o Facebook; app
"Conversões Otimizadas no Google Ads"). Escolher **um remetente só**: recomendação, o Wings, desligando
a integração do RD. Conferir no RD (só leitura, por quem tem acesso) se essas integrações estão
ligadas.

## Decisões do Eric (o que ficou escolhido até ele decidir)

| #   | Decisão                                        | Enquanto isso (opção mais segura)                                                    |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Ambiente (staging ou produção) e quando ligar  | tudo desligado nos dois                                                              |
| 2   | Qual etapa de cada funil é a COF               | nenhuma etapa configurada; ele escolhe na tela                                       |
| 3   | Quais etapas viram eventos e o nome de cada    | nenhuma; sugestão `reuniao_agendada`, `reuniao_realizada`, `proposta_enviada`, `cof` |
| 4   | Qual etapa a Meta otimiza                      | proposta: Reunião agendada (configuração na Meta, pelo Eric)                         |
| 5   | Ações do Google primárias ou secundárias       | começar secundárias (só medem)                                                       |
| 6   | Dado com hash antes da Política                | **não**: chave desligada; e só lead com consentimento                                |
| 7   | Só `lead_id` e ids de clique antes da Política | possível, depois de ouvir o Jurídico                                                 |
| 8   | O RD continua mandando eventos                 | recomendado não                                                                      |
| 9   | Valor por etapa                                | sem valor                                                                            |
| 10  | Dono das chaves                                | o Eric                                                                               |
| 11  | Dataset da Meta: pixel atual ou dataset de CRM | ele escolhe no Gerenciador; a variável recebe o id                                   |
| 12  | Quem autoriza a Data Manager                   | o Eric, numa conta de usuário com acesso à conta de anúncios                         |
| 13  | Etapa pulada                                   | manda só o que aconteceu                                                             |
| 14  | Mudanças do espelho do RD contam               | não                                                                                  |
| 15  | Leads de Expansão (marcas) e o controlador     | entram como os outros; Jurídico decide                                               |
| 16  | Data de corte                                  | obrigatória; sem ela nada sai                                                        |

## Lacunas que continuam

1. Nome, cidade, estado, CEP, IP e navegador não vão (minimização); a correspondência fica menor.
2. Formulário do site sem e-mail: o caminho com hash usa só o telefone.
3. Sem marca própria de "não usar em anúncios"; vale o "não me contate".
4. Sem retratação/ajuste de conversão no Google; sem apagar evento na Meta.
5. Os formatos seguem a documentação pública e estão **não verificados** contra as plataformas reais
   até o primeiro teste autorizado.

## Fontes oficiais

Lidas em **02/11/2026** (as de 13/10 foram conferidas de novo).

- Meta, integração de CRM: [visão geral e requisitos de otimização](https://developers.facebook.com/docs/marketing-api/conversions-api/conversion-leads-integration), [passo 3, campos e 7 dias](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/crm-integration/3-implementing-the-crm-integration)
- Meta, [uso da API](https://developers.facebook.com/docs/marketing-api/conversions-api/using-the-api) (endpoint, até 1.000 eventos, lote recusado por evento velho, `test_event_code` não descartado, "keep only the first copy" do mesmo `event_id`; relida em 02/11/2026 na revisão), [deduplicação](https://developers.facebook.com/documentation/ads-commerce/conversions-api/deduplicate-pixel-and-server-events) (48 horas)
- Meta, [dados do cliente](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters) (normalização de `em` e `ph`, `lead_id` sem hash, `fbc`/`fbp` sem hash)
- Meta, [fbp e fbc](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc) (formato, `creationTime` em ms, fbclid sensível a maiúsculas)
- Meta, [parâmetros do evento](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event) (`action_source`, `system_generated`)
- Meta, [deduplicação](https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events) (descrita para pixel × servidor; servidor × servidor não garantida)
- Meta, [changelog da Graph API](https://developers.facebook.com/docs/graph-api/changelog) (v26.0, 29/07/2026)
- Data Manager API: [`events.ingest`](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest) (até 2.000 eventos, escopo, `validateOnly`), [Destination](https://developers.google.com/data-manager/api/reference/rest/v1/Destination), [Consent](https://developers.google.com/data-manager/api/reference/rest/v1/Consent), [Encoding](https://developers.google.com/data-manager/api/reference/rest/v1/Encoding), [enviar eventos offline](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/send-events) (`UPLOAD_CLICKS`, deduplicação por `transactionId`), [migração, sem developer token](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/upgrade), [formatação](https://developers.google.com/data-manager/api/devguides/concepts/formatting) (e-mail, gmail, E.164, hex), [erros](https://developers.google.com/data-manager/api/devguides/concepts/understand-errors) (falha rápida), [diagnóstico](https://developers.google.com/data-manager/api/devguides/diagnostics), [notas de versão](https://developers.google.com/data-manager/api/reference) (`eventSource` obrigatório)
- Google Ads API, [conversões](https://developers.google.com/google-ads/api/docs/conversions/overview) (aviso de 15/06/2026, `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`) e [guia antigo](https://developers.google.com/google-ads/api/docs/conversions/legacy_oci_guide) (6 horas)
- Google Ads Ajuda: [importação offline](https://support.google.com/google-ads/answer/10029210) (90 e 63 dias, envio diário), [conversões otimizadas para leads](https://support.google.com/google-ads/answer/11021502) (criar a ação, termos de dados do cliente), [configuração única de dados fornecidos](https://support.google.com/google-ads/answer/16884284)
- ANPD, [Resolução CD/ANPD nº 19/2024](https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd/resolucao-cd-anpd-no-19-de-23-de-agosto-de-2024) (lida em 13/10)
