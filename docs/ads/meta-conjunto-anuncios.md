# Meta: conjunto de anúncios e anúncios (Onda 6)

19/09/2026. **Nada aqui foi escrito na Meta.** O código foi exercitado só contra
uma Graph API roteirizada (`platform/fake-meta-api.ts`). `ADS_WRITES_ENABLED`
não foi tocada.

Executar um `create_campaign` aprovado passa a criar a campanha **e o que vai
embaixo dela**: as mídias, **um** conjunto de anúncios e **um anúncio por
variação**. Isso muda o que o botão **Executar no Meta** faz — antes era uma
casca que não podia entregar; agora é uma campanha completa, pausada, a um
clique de entregar no Gerenciador.

## Regras

| Regra                             | Onde                                                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tudo nasce PAUSADO**            | campanha: o esquema recusa `startPaused: false` em toda plataforma; conjunto e anúncio: o cliente escreve `PAUSED` sozinho — a interface `AdTreeWriter` **não tem campo de status** |
| Nunca toca no que já existe       | `AdTreeWriter` só tem criações: não há update nem delete                                                                                                                            |
| Mesmo portão e mesmo budget-guard | nada mudou no caminho pedido → aprovação → clique                                                                                                                                   |
| `ADS_WRITES_ENABLED` governa      | sem a flag o cliente é leitor e não implementa `AdTreeWriter`                                                                                                                       |
| Sem automação de verba            | pedido de uma pessoa, um clique por execução, nenhuma tentativa automática                                                                                                          |

### Decisão: casca pausada é julgada como se estivesse ativa

Valia só para o Google; agora vale para a Meta também. A reserva gravada
continua **zero** (pausada), mas o pedido só passa se `verba × dias neste mês ×
1,25` couber na parcela utilizável, no teto e no `spend_cap`. Motivo: com
conjunto e anúncios prontos, ligar a campanha é um clique no Gerenciador, fora
do nosso sistema. "Nascer ativa" deixou de existir no construtor.

## Ordem de escrita

```
0. leituras (nada é enviado se falharem)
   - imagens no banco, vídeos no volume com o tamanho certo
   - estados/cidades → chaves de localização da Meta; idioma → Portuguese (Brazil)
   - nome da campanha ainda não existe na conta
1. campanha            POST act_…/campaigns      status PAUSED
2. mídias              POST act_…/adimages       (bytes em base64 → image_hash)
                       POST act_…/advideos       (start → transfer… → finish, depois espera `ready`)
3. conjunto            POST act_…/adsets         status PAUSED
4. por variação        POST act_…/adcreatives  → POST act_…/ads   status PAUSED
```

Cada mídia sobe **uma vez**, ainda que várias variações ou cartões a usem.

### Falha no meio

Cada objeto criado é gravado em `ad_execution_steps` **na hora em que passa a
existir** (tipo, nome, id na Meta). Se qualquer passo depois da campanha não
responder "criado":

- o passo fica gravado como `failed` (a Meta recusou) ou `unknown` (timeout,
  5xx, resposta sem id), com a mensagem;
- **nada mais é tentado**, nem agora nem depois — um segundo clique é recusado;
- a execução inteira vira **resultado desconhecido**: conta congelada (trava),
  evento de guardrail, auditoria — o mesmo caminho de sempre;
- a tela de aprovação mostra **"O que foi criado na Meta"**, passo a passo.

Se a própria **campanha** é recusada, nada existe: é uma recusa comum, a
reserva volta e a conta não congela.

Sair do congelamento: `ops-cli resolve-unknown` encontra a campanha pelo nome e
resolve como aplicada; **a árvore continua incompleta**. Completar ou apagar é à
mão, no Gerenciador, olhando a lista de passos. Não existe "continuar de onde
parou" — de propósito.

Um vídeo é caso especial: depois que `start` responde, o objeto de vídeo já
existe na Meta. Qualquer falha dali em diante (bloco, `finish`, processamento,
capa) é `unknown`, nunca `failed`.

## O conjunto de anúncios

- Sem orçamento: a campanha é CBO e é dona da verba.
- `billing_event: IMPRESSIONS`, `destination_type: WEBSITE`.
- Otimização: **leads** (e **conversão**) → `OFFSITE_CONVERSIONS` com
  `promoted_object { pixel_id: META_PIXEL_ID, custom_event_type: LEAD }`;
  **tráfego** → `LANDING_PAGE_VIEWS`.
- Segmentação: regiões e cidades por chave, raio do mapa como
  `custom_locations` (km), `age_min`/`age_max` (padrão 25–65), `locales` com
  Portuguese (Brazil), `targeting_automation.advantage_audience: 0` — para a
  faixa etária ser limite, não sugestão.
- Posicionamentos: **automático** = nenhum campo de posicionamento (é isso que
  Advantage+ significa na API); **manual** = `publisher_platforms` +
  `facebook_positions` (`feed`, `story`, `facebook_reels`) +
  `instagram_positions` (`stream`, `story`, `reels`). Threads não é uma
  plataforma à parte no catálogo do construtor — é um posicionamento da Meta:
  entra em `publisher_platforms` como `threads`, só tem `threads_positions`
  (`threads_stream`, feed) e exige que o Feed do Instagram (`stream`) também
  esteja marcado (regra da própria Meta), conferido pelo `placementsSchema`
  em `packages/shared`.
- Datas: `AAAA-MM-DDT00:00:00-0300` a `…T23:59:59-0300`.

Cidades e estados: um resultado exato ou recusa (`targeting_unresolved`),
nunca palpite — igual ao Google.

## Os anúncios

`object_story_spec` com `page_id` e `instagram_user_id` (o antigo
`instagram_actor_id` foi descontinuado na v22). Link sempre com as UTMs da
anúncio: o tipo e a posição no conjunto (`utm_content=video-1`, `imagem-2`,
`carrossel-3`…), para o RD e a tela Leads das Campanhas dizerem de qual anúncio
veio o lead (desde 29/09/2026; antes era `…-v1`, `-v2`).

| Tipo      | Formato na Meta                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Imagem    | `link_data` com `image_hash`                                                                                                                             |
| Vídeo     | `video_data` com `video_id` e `image_url` = capa gerada pela Meta                                                                                        |
| Carrossel | `link_data.child_attachments` (2–10), cada cartão com imagem ou vídeo, título, texto e link; `multi_share_optimized: false` para manter a ordem aprovada |

### Página e Instagram

`GET /ads/meta/identities` lê da Meta: `me/accounts` (páginas do usuário de
sistema) e, se vier vazio, `act_…/promote_pages`; Instagram por
`act_…/instagram_accounts`. **A ligação página ↔ Instagram não é lida** (exige
token de página): toda conta do Instagram da conta de anúncios aparece sob toda
página. A escolha pode ser guardada como padrão da Wings
(`marketing_meta_defaults`, auditado) e só aceita o que a Meta lista.

## Vídeos: onde ficam

Até 4 GB não cabem no banco. Ficam num **volume montado** (`CREATIVE_VIDEO_DIR`),
com nome gerado por nós; o banco guarda tamanho, hash e o nome. O upload é em
streaming (nunca em memória), confere o cabeçalho `ftyp` e o limite no caminho.
Sem a variável, `POST /ads/videos` responde **503** — nunca um sucesso falso — e
a execução de um pedido com vídeo é recusada (`media_missing`) antes de
qualquer escrita.

> ⚙️ **Infra pendente (Coolify):** criar um volume persistente na `wings-api`
> (staging e produção), montado em, p.ex., `/data/creative-videos`, e definir
> `CREATIVE_VIDEO_DIR`. O usuário do container precisa poder escrever ali.
> Conferir também o tempo limite de leitura do proxy (Traefik v3 usa 60 s por
> padrão): um upload grande pelo navegador pode ser cortado antes de terminar.

## Prévia oficial

Antes de os anúncios existirem **não há prévia oficial possível** sem escrever:
`generatepreviews` precisa da imagem dentro da Meta ou numa URL pública, e as
nossas imagens não são nem uma coisa nem outra. Por isso:

- no construtor e na aprovação pendente: a prévia **aproximada**, que diz ser
  aproximada;
- depois de executado: `GET /ads/approvals/:id/previews?placement=…` lê
  `/{ad_id}/previews` (somente leitura) para cada anúncio criado, em 6
  posicionamentos. O servidor só entrega ao navegador um endereço de
  `facebook.com`; a tela o mostra num `iframe` em sandbox.

## Rascunhos antigos

Pedidos aprovados antes desta onda não têm página, posicionamentos nem faixa
etária. Continuam executando **como foram aprovados**: só a campanha. A tela de
aprovação avisa.

## Não verificado — a primeira escrita responde

Tudo o que já estava aberto em [criar-campanha.md](criar-campanha.md)
(orçamento no nível da campanha sem conjunto, mínimo da conta, restrição
ativa), mais:

- [ ] O token do usuário de sistema lê `me/accounts` ou `promote_pages`? Tem
      acesso à Página para anunciar como ela?
- [ ] `adimages` com `bytes`, `advideos` em blocos, tempo real de processamento.
- [ ] `advantage_audience: 0` é aceito com OUTCOME_LEADS nesta conta? O pixel
      `1116678872845520` está ligado à conta e dispara `Lead`?
- [ ] **Objetivo "conversão"** usa o evento `LEAD`, por falta de outro evento
      configurado. Se a Meta recusar para `OUTCOME_SALES`, o objetivo sai do
      construtor ou ganha evento próprio.
- [ ] Nomes de estados e cidades como a busca da Meta devolve; a chave do
      idioma (esperado 31).
- [ ] `instagram_user_id` com a conta listada em `instagram_accounts`.
- [ ] Os `ad_format` das prévias de Stories/Reels.

## Limitações conhecidas

- **A execução é síncrona.** Um vídeo grande pode levar muitos minutos para
  subir e processar (espera até 15 min); o navegador ou o proxy podem desistir
  antes. O servidor **continua** e grava os passos — recarregar a aprovação
  mostra o estado. Para o primeiro teste, use vídeo pequeno.
- Sem barra de progresso real no upload de vídeo (indeterminada).
- Um conjunto por campanha; sem públicos salvos, interesses ou exclusões.
- "Escolher do Drive" segue desabilitado (onda 5).
- Apagar campanha/conjunto/anúncio de teste continua não existindo.

## Retomar liga a árvore inteira (28/09/2026)

Um `resume_campaign` aprovado e executado liga, na Meta, os anúncios, depois
os conjuntos e por último a campanha, os que o próprio sistema criou
(`companionsOf`, dos passos `ad_set` e `ad` do create_campaign). Nada feito à
mão entra na lista. Como a Meta não tem transação, a ordem é a proteção:
enquanto a campanha não estiver ativa nada entrega, então uma falha no meio
deixa filhos ligados sob uma campanha pausada, sem gasto, e o pedido fica
recusado (ou desconhecido, se a resposta não veio) com o que já foi ligado
anotado. No fim, o status de cada objeto é relido e gravado em
`statusesAfter` na execução, como no Google. Antes disso, "Retomar" ligava só
a campanha, e a campanha não entregava.

## Onda seguinte (sugestão)

Execução em segundo plano com acompanhamento na tela; `pause`/`resume` no nível
de conjunto e anúncio; apagar objetos de teste; validar antes de escrever
(`execution_options=["validate_only"]` da Meta) como preflight.

## Primeira escrita real (25/09/2026) e o que ela ensinou

A execução das 18:06 criou campanha `120252228318620076`, dois vídeos e o
conjunto `120252228329890076`, e parou no criativo v1 com `100: Invalid
parameter` — e nada mais: o cliente guardava só código e mensagem. Três
correções, todas exercitadas contra a API roteirizada:

- **Capa do vídeo como `image_hash`.** A URL assinada do CDN
  (`video_data.image_url`) era a hipótese principal da recusa. Agora a capa
  preferida é baixada e sobe em `adimages`; o criativo recebe `image_hash`
  (também nos cartões de carrossel com vídeo, **não verificado ao vivo**).
- **Erro completo guardado.** `error_subcode`, `error_user_title`,
  `error_user_msg` e `fbtrace_id` entram na mensagem do passo e em
  `platform_response` (`subcode`, `userTitle`, `userMessage`, `fbtraceId`).
- **`validate_only` antes de cada criativo.** `POST act_…/ads` com o criativo
  inline e `execution_options=["validate_only"]`: a Meta julga página,
  Instagram, mídia e texto sem criar nada; uma recusa é o passo `creative`
  falhando com `validate_only: …`, e nada mais existe na plataforma. Só é
  possível depois de existirem campanha, vídeos e conjunto (o anúncio precisa
  de `adset_id`), então é "antes de qualquer escrita de criativo ou anúncio".
- **Vídeos não sobem duas vezes.** O passo `video` guarda o id local em
  `message` (`video:<uuid>`); um novo pedido com o mesmo vídeo encontra o id
  da Meta, confere que está `ready`, refaz só a capa (`adimages` com os mesmos
  bytes devolve o mesmo hash) e segue — passo `Vídeo … (reaproveitado)`.

A campanha ficou **ACTIVE** na Meta a partir das 18:10 por ação no
Gerenciador (o sistema a criou e releu PAUSED); foi pausada de novo por uma
pessoa. Não existe "continuar de onde parou": a campanha antiga é arquivada à
mão e o pedido é feito de novo a partir do rascunho salvo.

### Pedido versus rascunho salvo (28/09/2026)

A tela de aprovação compara o pedido com o **rascunho salvo de mesmo nome e
plataforma** (o mais recente) e destaca em vermelho o que difere: verba
diária, início, fim, destino, área de alcance e público (cliente ideal e
idade). Quando tudo confere, diz isso numa linha. Motivo: em 25/09 um pedido
saiu com o dobro da verba e um período menor que o rascunho combinado, e o
aprovador não tinha como notar. O vínculo é pelo nome, não por id: renomear a
campanha no construtor desliga a comparação.

### UTMs da Meta: `facebook` / `cpc` (28/09/2026)

O padrão do construtor para a Meta passou de `utm_source=meta&utm_medium=paid_social`
para **`utm_source=facebook&utm_medium=cpc`**: o RD Station não reconhece
`paid_social` (fonte "Desconhecido") e lê `cpc` + `facebook` como "Busca Paga |
Facebook Ads". Nos anúncios ativos da campanha `120252260012720076` a troca foi
feita à mão pela API (o criativo da Meta é imutável): criativos novos iguais
com o link corrigido (`1100345526226556` para v1, `3651541801687471` para
v2), `validate_only` da troca e depois a troca no anúncio, sem pausar nada;
registrado na trilha como `ads.manual_platform_change`. A troca de criativo
manda o anúncio de volta à revisão (`IN_PROCESS`).


## Vários criativos e anúncios novos numa campanha que já existe (29/09/2026)

- **De 1 a 5 criativos por conjunto** (antes, de 2 a 3). O construtor abre com
  2 e deixa remover até 1. Cada criativo vira um anúncio no mesmo conjunto, com
  texto, título e botão próprios, ou o mesmo em todos ("Usar o mesmo texto…").
- **utm_content por anúncio**: `video-N`, `imagem-N`, `carrossel-N`, com N a
  posição no conjunto (`adUtmContent` em `packages/shared`).
- **Só Instagram**: atalho nos posicionamentos manuais que deixa Instagram
  Feed, Stories e Reels e tira Facebook e Threads (Audience Network não é
  oferecida pelo construtor).
- **Adicionar criativos a uma campanha existente** (`add_ads`, migração
  0046): no construtor, "Adicionar criativos a uma campanha existente". O
  pedido guarda o conjunto (o único da campanha, ou o escolhido) e continua a
  numeração do utm_content depois dos anúncios que já existem. Não reserva
  verba, mas passa pela aprovação como tudo. Na execução: confere que o
  conjunto ainda pertence à campanha na Meta, que o pedido é o aprovado (hash)
  e que os arquivos existem; sobe a mídia; valida cada anúncio
  (`validate_only`) e cria cada um **pausado**. Nada criado: recusado. Parte
  criada: desconhecido e a conta travada, como toda escrita pela metade.
  Ligar: pedido "Retomar campanha" (liga também estes anúncios, porque o
  sistema os criou) ou na Meta.
- **Aprovação**: lista cada criativo com o seu utm_content; "Total previsto
  da campanha até o fim" (verba diária × dias, da criação ao fim, ou de hoje
  ao fim numa mudança de verba); "Solicitado por" diz quando o pedido veio do
  terminal (`ops-cli request --requested-by e-mail` registra a pessoa).
