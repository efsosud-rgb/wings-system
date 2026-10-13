# Fechar o ciclo — etapas do CRM de volta para a Meta e o Google

13/10/2026. **Plano. Nada foi construído e nada foi enviado.** Para escrever este arquivo só se leu o
código e a documentação pública das plataformas; nenhuma chamada à Meta, ao Google ou ao RD.

Ordem do Eric (13/10): devolver à Meta e ao Google os leads que chegam a **Reunião agendada**,
**Reunião realizada**, **Proposta enviada** e **COF**. Hoje as plataformas só sabem que alguém
preencheu um formulário. Com as etapas, a campanha passa a ser medida por reunião e proposta, não
por lead; e a Meta pode entregar o anúncio a quem tem mais chance de virar reunião.

## Resumo

- **Meta, formulário instantâneo:** a integração de CRM da API de Conversões aceita o evento com o
  `lead_id` da Meta, que nós já guardamos. É o caminho mais simples e o mais forte.
- **Meta, leads do site e do RD:** só com dados com hash (e-mail, telefone) e o `fbclid`. O
  formulário novo do site não pede e-mail; as páginas do RD pedem.
- **Google mudou a porta.** Desde 15/06/2026, `UploadClickConversions` da Google Ads API falha para
  um developer token que nunca enviou conversões offline. Pelo repositório, o nosso nunca enviou. O
  caminho é a **Data Manager API**, que não usa developer token (o nível Explorer deixa de importar).
- **Lacuna no Google:** o `gcl_id` que o formulário de lead do Google manda no webhook não é gravado.
- **LGPD:** a Política de Privacidade não existe, e os textos de consentimento falam só de contato.
  Enviar dado com hash antes disso: recomendação **não**.
- **Onde roda:** a equipe usa o staging desde 09/10 e a produção está parada. Isso pesa na escolha
  (seção 3).
- **Um remetente só:** o RD pode já mandar eventos próprios à Meta e ao Google. É preciso conferir e
  escolher.

## 0. As etapas, no nosso banco

- As etapas não estão fixas no código. Vêm do RD (`ensureStage`), uma lista por funil (`expansao`,
  `formatacao`, `consultoria`), em `crm_stages`. Um gestor renomeia, reordena e cria etapas em
  Administração → CRM.
- Nomes vistos no repositório: "Reunião agendada", "Reunião realizada" e "Proposta enviada" (testes
  de `funnel-sync`, `crm-routes`, `rd-import`). **"COF" não aparece como nome de etapa no código.**
- No repositório, COF é a **Circular de Oferta de Franquia** (`navigation.ts`), e o BI conta o marco
  "COF enviada" (`dw.fato_negociacao.cof_enviada_sk`). A ordem fala em formulário assinado. Qual dos
  dois vale, e qual etapa de cada funil é essa: decisão do Eric, conferindo na tela.
- **A ligação é pelo id da etapa** (`crm_stages.id`), nunca pelo nome. Uma tabela pequena diz "esta
  etapa deste funil = este evento na Meta = esta ação de conversão no Google". Renomear uma etapa não
  muda nada nem reenvia nada.
- **A fonte é `lead_stage_history`** (só acrescenta linhas): `lead_id`, `to_stage_id`, `at` e
  `source` (`wings`, `rd`, `import`, `sofia`). O evento é a **primeira** entrada do lead na etapa.
- Linhas com `source = 'import'` (carga de histórico do RD) **nunca** são enviadas: a data é antiga
  e não é o momento real. Linhas `rd` (espelho de hora em hora) têm a hora em que vimos a mudança,
  não a hora real; entram só se o Eric decidir.

## 1. Meta — API de Conversões (CAPI)

CAPI é a porta da Meta para o nosso servidor mandar eventos, sem depender do navegador. Os eventos
caem num **dataset** (conjunto de dados de eventos; o pixel é um dataset).

### 1.1 Leads do formulário instantâneo: integração de CRM ("Conversion Leads")

Pedido para `POST https://graph.facebook.com/<versão>/<DATASET_ID>/events`, até 1.000 eventos por
lote:

| Campo                           | Valor                                                           |
| ------------------------------- | --------------------------------------------------------------- |
| `event_name`                    | livre: o nome da etapa no CRM (proposta: `reuniao_agendada`, …) |
| `event_time`                    | Unix em segundos: a entrada na etapa (`lead_stage_history.at`)  |
| `action_source`                 | `system_generated` (obrigatório nesse caminho)                  |
| `user_data.lead_id`             | o id do lead na Meta, 15 a 17 dígitos, **sem hash**             |
| `custom_data.event_source`      | `crm` (fixo)                                                    |
| `custom_data.lead_event_source` | o nome do CRM que manda (proposta: `Wings System`)              |
| `event_id`                      | o id da nossa linha de envio (seção 6)                          |

- **De onde vem o `lead_id`:** `meta_leadgen_events.leadgen_id`, achado pelo `lead_id` do lead. Isso
  cobre o lead que se juntou a um contato existente (mesmo telefone): nesse caso `leads.source` e
  `leads.external_id` continuam os da primeira origem. `leads.external_id` com
  `source = 'meta_lead_ads'` fica como reserva. Se houver mais de um formulário para o mesmo lead,
  vale o mais recente antes da etapa.
- A Meta pede **todas as etapas**, inclusive o lead bruto. Então o lead que entra pelo formulário
  também gera um evento `Lead` nesse dataset.
- A Meta pede envio **ao menos uma vez por dia**; o ideal é logo após a mudança.
- Para otimizar a entrega por uma etapa, a Meta pede: só formulário instantâneo; **200 leads por mês
  ou mais**; a etapa acontece **em até 28 dias** depois do lead; taxa de conversão entre **1% e
  40%**. Nosso volume atual de formulário da Meta precisa ser conferido antes de prometer otimização.
  Sem esse volume, os eventos ainda servem para medir.
- Configuração no Gerenciador de Eventos: conectar fonte de dados → CRM → criar dataset novo ou
  converter um existente. O token de acesso desse dataset é gerado lá e é **outro** token, só para
  isso (nome proposto: `META_CAPI_TOKEN`). Depois, na configuração do funil de vendas, as etapas
  aparecem; a pessoa ordena e escolhe a primeira etapa a otimizar.
- A cobertura de leads (leads com eventos enviados) deve chegar a 60% ou mais; a Meta mostra isso nas
  configurações do dataset.

### 1.2 Leads do site, do link e do RD: dados com hash

Sem `lead_id`, a Meta aceita identificadores do cliente. O hash é SHA-256: transforma o dado num
código fixo; o mesmo e-mail dá sempre o mesmo código, e a Meta compara com o que ela tem. Esses
eventos medem e alimentam públicos; a otimização "Conversion Leads" vale só para formulário
instantâneo. Usar esses eventos como meta de campanha de site: **não verificado**.

| Campo da Meta      | Regra da Meta                                | Temos hoje?                                                    |
| ------------------ | -------------------------------------------- | -------------------------------------------------------------- |
| `em` (e-mail)      | sem espaços nas pontas, minúsculas, hash     | `leads.email`, já minúsculo. Vazio no formulário novo do site  |
| `ph` (telefone)    | só dígitos, com código do país, hash         | `leads.phone` (55 + DDD + número). **Sim**                     |
| `fn` / `ln` (nome) | minúsculas, sem pontuação, UTF-8, hash       | só `leads.name` inteiro. Separar é palpite                     |
| `ct` (cidade)      | minúsculas, sem pontuação nem espaço, hash   | `leads.city`, como digitado. Regra para acento: não verificado |
| `st` (estado)      | código de 2 letras em minúsculas, hash       | **não temos**. A regra escrita é a dos EUA; UF: não verificado |
| `zp` (CEP)         | sem espaço nem traço, hash                   | **não temos**                                                  |
| `country`          | ISO de 2 letras em minúsculas (`br`), hash   | não há coluna; telefone com 55 indica Brasil                   |
| `fbc` (clique)     | `fb.1.<criação em ms>.<fbclid>`, sem hash    | `leads.fbclid`. A criação seria `entered_at`: aproximação      |
| `fbp` (navegador)  | sem hash                                     | **não guardamos**                                              |
| IP e navegador     | sem hash; navegador obrigatório em `website` | **não guardamos**. Por isso o evento usa `system_generated`    |
| `external_id`      | hash recomendado                             | o id do lead (uuid), se o Eric quiser                          |

- O hash é feito na hora do envio, em memória. **Nunca é gravado nem vai para log.**
- O pixel do site já manda `Lead` do navegador no envio do formulário (`site-conversion.ts`). Não
  mandar outro `Lead` pelo servidor para lead do site, ou ele conta duas vezes.

### 1.3 Tempo e id do evento

- `event_time` até **7 dias no passado** na hora do envio. Se um evento do lote passa disso, a Meta
  recusa **o lote inteiro**. O envio filtra antes de montar o lote.
- No caminho de CRM, `event_time` precisa ser **depois** da criação do lead, ou o evento pode ser
  descartado.
- `event_id`: o id da nossa linha de envio. Não leva dado pessoal.

## 2. Google Ads — importação de conversões offline

GCLID é o código que o Google põe no endereço quando alguém clica no anúncio. Ação de conversão é o
"contador" do Google onde a conversão cai; os lances automáticos (Smart Bidding) aprendem com ela.

### 2.1 A porta mudou: Data Manager API

O Google diz: desde **15/06/2026**, `ConversionUploadService.UploadClickConversions` falha se o
developer token nunca enviou conversões offline ou "enhanced conversions for leads". O nosso token
(nível Explorer, ver [pesquisa-palavras-chave-set26.md](pesquisa-palavras-chave-set26.md)) nunca
enviou, pelo que o repositório mostra; uso fora do sistema: não verificado. **Para nós, esse método
está fechado.** O Google recomenda a Data Manager API.

- Pedido: `POST https://datamanager.googleapis.com/v1/events:ingest`, até 2.000 eventos.
- Acesso: projeto no Google Cloud com a Data Manager API ligada; escopo OAuth
  `https://www.googleapis.com/auth/datamanager`; uma conta de usuário ou de serviço com acesso à conta
  de anúncios. **Não pede developer token.** A autorização atual (`GOOGLE_ADS_*`) foi dada para o
  Google Ads; a Data Manager pede o escopo dela, então é preciso autorizar de novo (Eric).
- É outra API, não a v22 da Google Ads API. O fim da v22 (ver [google-escrita.md](google-escrita.md))
  não a atinge.

O que a ordem cita, e onde fica na Data Manager:

| Google Ads API (porta antiga)                 | Data Manager API                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `gclid` / `gbraid` / `wbraid`                 | `adIdentifiers.gclid` / `gbraid` / `wbraid`                                        |
| `conversion_action` (tipo `UPLOAD_CLICKS`)    | `destinations[].productDestinationId` (a mesma ação, mesmo tipo)                   |
| `conversion_date_time`                        | `eventTimestamp` (ISO 8601 com fuso)                                               |
| `conversion_value` / `currency_code`          | `conversionValue` / `currency` (`BRL`)                                             |
| `order_id`                                    | `transactionId`                                                                    |
| `consent.ad_user_data` / `ad_personalization` | `consent.adUserData` / `adPersonalization` (`CONSENT_GRANTED` ou `CONSENT_DENIED`) |
| `user_identifiers` (hash)                     | `userData.userIdentifiers` (hash, `encoding: HEX`)                                 |
| `partial_failure: true`                       | não existe: **um evento ruim derruba o pedido inteiro**                            |
| `validate_only`                               | `validateOnly`                                                                     |

- Uma ação de conversão por etapa, tipo `UPLOAD_CLICKS`, criada por uma pessoa no Google Ads (Metas →
  Conversões). Janela de clique em 90 dias. Depois de criar, esperar **6 horas** antes do primeiro
  envio.
- Também é preciso `eventSource`. Qual valor serve para etapa de CRM: **não verificado**.
- O Google recomenda **fortemente** preencher o consentimento; sem ele, a conversão pode não ser
  atribuída.

### 2.2 Com GCLID

- Temos `leads.gclid`, `leads.gbraid` e `leads.wbraid`, gravados pelo formulário do site e pelo RD
  (`rd-attribution.ts`). Primeiro toque, nunca sobrescritos.
- **Lacuna:** o webhook do formulário de lead do Google traz `gcl_id`, mas `google-leads.ts` não o
  lê nem o grava. Conserto pequeno, antes de tudo.
- O Google recomenda mandar o GCLID sempre que houver, mesmo junto com o hash.

### 2.3 Com dado com hash ("enhanced conversions for leads")

- E-mail: sem espaços nas pontas, minúsculas; em gmail.com e googlemail.com, tirar pontos e o que vem
  depois do `+` antes do `@`. Telefone em E.164 (`+55…`). Hash SHA-256. Até 5 identificadores por
  evento.
- Na conta: ligar "conversões otimizadas para leads" e aceitar os termos de dados do cliente. Como
  isso se aplica ao envio pela Data Manager: **não verificado**.
- Mesma restrição de LGPD da Meta (seção 4).

## 3. Onde roda

Situação: desde 09/10 a equipe trabalha no **staging**; a produção está parada até ordem nova do
Eric. `ADS_WRITES_ENABLED` é do Eric e trata de campanhas e verba. Este envio não gasta dinheiro,
mas muda o que as plataformas aprendem. Por isso tem **chave própria por plataforma**, desligada por
padrão, também do Eric (nomes propostos: `CRM_CONVERSIONS_META_ENABLED`,
`CRM_CONVERSIONS_GOOGLE_ENABLED`). Não há conta de teste (sandbox): todo envio cai na conta real.

**(a) Produção, tarefa de hora em hora, desligada por padrão.**

- Prós: é onde o sistema oficial vai viver; não mistura com testes de quem programa.
- Contras: hoje a produção não recebe as mudanças de etapa da equipe, então não haveria o que enviar.
  Pede deploy e migração na produção, só com PRODUCAO digitado pelo Eric.

**(b) Staging, com a mesma chave própria.**

- Prós: as mudanças de etapa reais estão lá hoje; dá para começar antes.
- Contras: o staging também recebe testes e leads inventados. Um envio errado vai para o dataset e a
  ação de conversão reais, e não se desfaz. O staging recebe deploy com frequência.
- Travas, se for (b): só leads com identificador vindo da entrada real (`lead_id` de
  `meta_leadgen_events`, `gclid` gravado na entrada); só mudanças `wings` ou `sofia`; nunca leads de
  `csv_import` ou `manual`. A tabela de envios não migra entre ambientes: ao mudar de ambiente, o novo
  só envia depois de uma data de corte, ou manda tudo de novo.

**(c) Comando manual, simular → aplicar.**

- Prós: uma pessoa vê a lista antes (por id de lead, nunca nome), como nos outros scripts de simular
  → aplicar. Bom para o primeiro teste e para recuperar atrasos do Google.
- Contras: depende de alguém rodar todo dia. A Meta não aceita nada com mais de 7 dias: uma semana
  esquecida é uma semana perdida.

**(d) Pelo RD Station.**

- O que o RD tem: no RD Station Marketing, integração com o Facebook, opção "API de Conversões", que
  manda **venda** marcada no lead; e o app pago "Conversões Otimizadas no Google Ads", que manda envio
  de formulário e **Oportunidade** para ações de conversão do Google.
- Contras: o RD não conhece nossas quatro etapas, só Oportunidade e Venda. Desde 05/10 o CRM oficial
  é o Wings e o RD é cópia; a etapa lá pode estar velha. Em 09/10 a cópia dos leads da Meta para o RD
  (`META_LEADS_RD_COPY_ENABLED`) estava desligada no staging, então o RD nem tem esses leads. Sem
  `lead_id`, não há "Conversion Leads".
- Conferir no RD (só leitura, por quem tem acesso): se a "API de Conversões" está ligada e com qual
  pixel; se o app do Google está instalado e quais ações usa; se alguém marca Oportunidade e Venda.

**Recomendação:** começar por (c), com poucos leads. Depois, a tarefa automática no ambiente onde a
equipe estiver: (b) se o staging seguir sendo o sistema em uso por semanas; (a) quando a produção
voltar. Desligar o que o RD manda, para haver um remetente só.

**Regras para qualquer opção:**

- O envio roda **dentro da API**, como a ingestão de hora em hora: token de serviço externo não sai
  da API (AGENTS.md). Nunca vai ao navegador, a um log, a uma resposta ou a um modelo de linguagem.
- Cada envio nasce como linha na tabela de envios **antes** da chamada (nome proposto:
  `ad_conversion_sends`). A linha nunca é apagada; o resultado é escrito uma vez, depois da chamada.
  Colunas: id, `tenant_id`, `lead_id`, `stage_id`, `stage_key`, `platform`, destino (dataset ou ação),
  tipo de identificador (`lead_id`, `gclid`, `hashed`…), **nomes** dos campos enviados (nunca
  valores), `event_time`, resultado, id do pedido na plataforma, formato da resposta (`shapeOf`).
  Chave única: `lead_id` + `stage_key` + `platform`.
- Resultados: `sent`, `rejected`, `unknown`, `skipped_expired`, `skipped_no_identifier`,
  `skipped_no_consent`.
- **Sem nova tentativa às cegas.** Tempo esgotado vira `unknown` e fica assim até uma pessoa conferir
  na plataforma, como `ops-cli resolve-unknown` faz com campanhas
  (ver [travas.md](travas.md)). Recusa da plataforma (dado inválido) é `rejected` e não volta.
- Logs: só contagens e formato das respostas. Nunca hash, telefone, e-mail ou nome.

## 4. LGPD — antes de mandar dado com hash

Hash é **pseudonimização, não anonimização**: a plataforma usa o hash justamente para achar a pessoa.
Continua sendo dado pessoal. A Política de Privacidade precisa existir e dizer, no mínimo:

1. **Finalidade:** medir e melhorar anúncios, informando à Meta e ao Google quais contatos viraram
   reunião, proposta ou COF.
2. **Base legal:** consentimento (os formulários registram `legal_basis`, `consented_at`,
   `consent_source`, `consent_text`) ou legítimo interesse, com o teste de balanceamento. Hoje os
   textos gravados falam só de contato por telefone, WhatsApp e e-mail (`siteFormCopyOf`,
   `SITE_FORM_CONSENT_TEXT`); não cobrem anúncio.
3. **Quem recebe:** Meta e Google, nomeados.
4. **Transferência internacional:** as duas tratam dados fora do Brasil (arts. 33 a 36 da LGPD;
   Resolução CD/ANPD nº 19/2024, cláusulas-padrão).
5. **O que vai:** e-mail e telefone com hash, ids de clique e de lead, a etapa e a data. Dizer que
   hash não é anonimização.
6. **Retenção:** por quanto tempo nós guardamos o registro de envio e o que as plataformas dizem
   guardar.
7. **Direitos do titular** (art. 18) e **como se opor**: um pedido de "não usar meus dados em
   anúncios" vira uma marca no lead que bloqueia o envio. Essa marca ainda não existe.
8. **Quem é o controlador** e o contato do **encarregado** (DPO).

- Recomendado: o texto de consentimento dos formulários (site, Meta, Google) passa a citar a medição
  de anúncios e apontar para a Política.
- Os formulários da Meta e do Google já exigem um link de política. Conferir para onde apontam hoje.
- Leads de **Expansão** são candidatos à franquia de uma marca: quem é o controlador (a marca ou a
  Wings) muda quem precisa da política e do consentimento.
- `opt_out` da Meta não resolve: só tira o evento da otimização, e o dado vai do mesmo jeito.

> ⚠️ Esta lista é técnica, não parecer jurídico. **O Jurídico revisa** a base legal, a política, o
> texto de consentimento e a transferência internacional antes de qualquer envio com hash.

## 5. Prazos

| Plataforma | Regra                                                                           | Prazo            |
| ---------- | ------------------------------------------------------------------------------- | ---------------- |
| Meta       | `event_time` no passado, na hora do envio (um velho derruba o lote)             | até 7 dias       |
| Meta       | etapa que a Meta otimiza, contada do lead                                       | até 28 dias      |
| Meta       | frequência de envio                                                             | ao menos 1×/dia  |
| Google     | conversão com GCLID, contada do clique                                          | até 90 dias      |
| Google     | e mais: dentro da janela de clique da ação (1 a 90 dias), senão `EXPIRED_EVENT` | a janela da ação |
| Google     | conversão só com dado com hash, contada do clique                               | até 63 dias      |
| Google     | ação de conversão nova antes do primeiro envio                                  | esperar 6 horas  |
| Google     | frequência para os lances automáticos                                           | ao menos 1×/dia  |

O que isso quer dizer para um ciclo em que a COF chega semanas depois:

- **Meta:** a COF ainda pode ser enviada, desde que no máximo 7 dias depois da mudança de etapa (a
  tarefa diária resolve). Para otimização, a etapa precisa acontecer em até 28 dias do lead: o alvo
  realista é **Reunião agendada**. Se a Meta usa eventos que chegam depois de 28 dias: **não
  verificado**.
- **Google:** passou de 90 dias do clique (63 só com hash), a conversão se perde. COF tardia pode não
  entrar. Antes de escolher qual ação entra nos lances, medir os dias do lead até cada etapa (o BI já
  tem os marcos em `dw.fato_negociacao`).
- **Atrasados:** na Meta não há recuperação além de 7 dias. No Google, dá para enviar uma vez as
  etapas desde `CRM_TRACKING_START` (09/10), dentro dos 90 dias do clique.

## 6. Sem duplicata

- **Uma vez por lead, por etapa, por plataforma.** A chave única da tabela de envios garante, mesmo
  com duas tarefas rodando ao mesmo tempo.
- **Etapa que vai e volta:** conta só a primeira entrada. Voltar e entrar de novo não reenvia.
- **Etapa pulada** (de "Novo" direto para "Proposta enviada"): o padrão proposto é mandar só o que
  aconteceu. Mandar também as anteriores é decisão do Eric.
- **Lead reaberto** (pessoa com negócio fechado que volta e ganha negócio novo, `reopenClosed`): é
  outro lead, com outro `lead_id` da Meta. Envia de novo, e está certo.
- **Meta:** `event_id` = id da nossa linha. **Google:** `transactionId` = o mesmo id. Se a
  plataforma descarta um reenvio com o mesmo id em eventos de CRM: **não verificado**. Por isso não
  dependemos disso: a nossa tabela é a trava.
- **RD mandando também:** escolher um remetente só. Recomendação: o Wings, desligando a integração do
  RD.
- **Tags do site:** o `Lead` do pixel e a conversão do Google no envio do formulário são outros
  eventos e outras ações. Não colidem com as etapas.

## 7. Como testar

Não há conta de teste. **Todo teste toca a conta real.**

- **Nosso código:** testes com APIs falsas, como `platform/fake-meta-api.ts` e
  `platform/fake-google-api.ts`, e a trava sem rede (`no-network.ts`). Dados inventados. Nenhum teste
  chega à plataforma.
- **Meta:** ferramenta "Testar eventos" do Gerenciador de Eventos, com `test_event_code` no pedido.
  A própria Meta diz que esses eventos **entram no Gerenciador de Eventos para público e medição**.
  Usar um nome de evento só de teste (ex.: `teste_wings`) e marcá-lo em "Outras etapas" na
  configuração do funil. Um `lead_id` inventado é recusado; o caminho é um funcionário preencher um
  formulário real, com o consentimento dele. A ferramenta de lead de teste da Meta serve para isso:
  **não verificado**.
- **Google:** primeiro `validateOnly: true` (valida e não grava nada; não gera diagnóstico). Depois,
  uma ação de conversão **de teste**, secundária (só observa, não entra nos lances), com um GCLID
  real. Conferir pelo `RetrieveRequestStatus` da Data Manager (primeira consulta após 30 minutos, até
  24 horas) e no Google Ads, no diagnóstico da ação.
- Ordem: Google `validateOnly` → um lead real na ação de teste → uma semana olhando os
  diagnósticos → só então as ações reais.

## 8. Como desligar

- **Chave por plataforma** (`false`): a tarefa não envia nada. Não há fila: a tarefa calcula o que
  falta a partir de `lead_stage_history`. Uma chamada já em curso termina e grava o resultado.
- **Ao religar:** a tarefa olha só dentro dos prazos (Meta 7 dias; Google 90 dias do clique). Se não
  for para recuperar o período desligado, uma data de corte evita a enxurrada (decisão do Eric).
- **Na Meta:** desconectar a integração de CRM no Gerenciador de Eventos, ou revogar o token do
  dataset.
- **No Google:** tornar a ação secundária (para de influir nos lances e guarda o histórico) ou
  removê-la; revogar a autorização da Data Manager.
- **O que já foi enviado não volta.** Na Meta, apagar um evento enviado: não verificado; contar que
  não dá. No Google existe ajuste de conversão (retração); como fazer pela Data Manager: não
  verificado.
- Esta chave não tem relação com a trava das contas (`kill_switch_engaged`), que é de verba.

## Lacunas no código hoje

1. `gcl_id` do formulário de lead do Google não é gravado (`google-leads.ts`).
2. Nome num campo só; sem estado, CEP e país; sem `fbp`, IP e navegador.
3. Formulário da Meta e do site sem e-mail (ver [formulario-no-anuncio.md](formulario-no-anuncio.md)
   e [../leads/formularios.md](../leads/formularios.md)).
4. Textos de consentimento sem menção a anúncio; nenhuma marca de oposição por lead.
5. Não há cliente da CAPI nem da Data Manager; não há tabela de etapa → evento nem tabela de envios.
6. Uma tabela nova precisa de `GRANT` para `wings_ro` numa migração, ou não é lida pelo
   `wings-staging-sql`.

## Decisões do Eric

1. Ambiente: (a) produção, (b) staging com chave própria, ou (c) só comando manual primeiro.
2. "COF": Circular enviada (como no BI) ou assinatura de outro documento; e qual etapa de cada funil.
3. Quais etapas viram eventos, por funil (`expansao`, `formatacao`, `consultoria`), e o nome de cada.
4. Qual etapa a Meta otimiza (proposta: Reunião agendada).
5. Quais ações do Google entram nos lances (primárias) e quais só medem (secundárias).
6. Dado com hash de leads do site antes da Política existir: recomendado **não**.
7. Até lá, só `lead_id` (Meta) e GCLID (Google): sim ou não, depois de ouvir o Jurídico.
8. O RD continua mandando os eventos dele: recomendado **não**, um remetente só.
9. Valor por etapa (em reais) ou sem valor.
10. Dono das chaves `CRM_CONVERSIONS_META_ENABLED` e `CRM_CONVERSIONS_GOOGLE_ENABLED`: proposto, o
    Eric.
11. Dataset da Meta: converter o pixel atual (`META_PIXEL_ID`) ou criar um dataset de CRM.
12. Google: quem cria o projeto Cloud e autoriza a Data Manager (conta de usuário ou de serviço).
13. Etapa pulada: mandar só o que aconteceu, ou também as anteriores.
14. Mudanças espelhadas do RD (`source = 'rd'`) contam ou não.
15. Leads de Expansão (marcas) entram, e quem é o controlador (com o Jurídico).
16. Data de corte para o primeiro envio e para religar depois de uma pausa.

## Fontes

Lidas em 13/10/2026.

- Meta, integração de CRM: [visão geral](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration), [passo 2, dataset](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/crm-integration/2-getting-started-with-integration), [passo 3, campos e 7 dias](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/crm-integration/3-implementing-the-crm-integration), [passo 4, cobertura](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/crm-integration/4-verify-your-data), [passo 5, funil](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/crm-integration/5-configure-your-sales-funnel)
- Meta, [parâmetros do evento](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event) (`event_time`, `event_id`, `action_source`, `opt_out`)
- Meta, [dados do cliente](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters) (normalização, hash, `fbc`, `lead_id`)
- Meta, [uso da API](https://developers.facebook.com/documentation/ads-commerce/conversions-api/using-the-api) (lote recusado por evento velho, `test_event_code`)
- Google Ads API, [conversões offline](https://developers.google.com/google-ads/api/docs/conversions/upload-offline) (aviso de 15/06/2026, consentimento, hash)
- Google Ads API, [upload de cliques](https://developers.google.com/google-ads/api/docs/conversions/upload-clicks) (`UPLOAD_CLICKS`, 6 horas, `order_id`) e [guia antigo](https://developers.google.com/google-ads/api/docs/conversions/legacy_oci_guide) (`partial_failure`)
- Google Ads API, [solução de problemas](https://developers.google.com/google-ads/api/docs/conversions/troubleshooting) (`EXPIRED_EVENT`)
- Google Ads Ajuda, [importação offline](https://support.google.com/google-ads/answer/10029210) (90 e 63 dias, envio diário) e [janelas de conversão](https://support.google.com/google-ads/answer/3123169)
- Data Manager API: [enviar eventos](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/send-events), [`events.ingest`](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest), [acesso](https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access), [diagnóstico](https://developers.google.com/data-manager/api/devguides/diagnostics)
- RD Station, [novidades de outubro de 2024](https://www.rdstation.com/blog/marketing/novidades-rd-station-marketing-outubro-2024/) (API de Conversões da Meta) e [Conversões Otimizadas no Google Ads](https://www.rdstation.com/integracoes/conversoes-otimizadas-no-google-ads/)
- ANPD, [Resolução CD/ANPD nº 19/2024](https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd/resolucao-cd-anpd-no-19-de-23-de-agosto-de-2024)
