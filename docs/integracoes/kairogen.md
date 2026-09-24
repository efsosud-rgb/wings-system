# Kairogen (geração de imagem e vídeo) — integração

> Desde a onda "Provedores de mídia", o Kairogen é o **primeiro de vários
> provedores** atrás de um contrato só (`modules/media/providers/kairogen.ts`),
> sem mudança no que ele faz. O que vale para todos (roteamento, teto em
> reais, tela, agente) está em [provedores-de-midia.md](provedores-de-midia.md);
> este documento continua sendo a referência do Kairogen em si.

Kairogen é o serviço que gera e edita imagens e vídeos para o sub-módulo
Marketing → Edição de Fotos e Vídeos. O Wings System fala com ele por **MCP**
(Model Context Protocol, transporte Streamable HTTP), autenticado por **OAuth
2.1**. A conexão é **uma só, do sistema** (uma conta Wings), feita por um Admin
Master.

## Descoberta (21/09/2026, só leitura)

Feita com três `GET` públicos e um `initialize` **sem token**. Nada foi
registrado nem criado no Kairogen.

| Pergunta                         | Resposta                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Recurso protegido                | `https://mcp.kairogen.ai` (endpoint MCP: `https://mcp.kairogen.ai/mcp`)                                            |
| Servidor de autorização (issuer) | `https://api.kairogen.ai`                                                                                          |
| `authorization_endpoint`         | `https://app.kairogen.ai/oauth/consent`                                                                            |
| `token_endpoint`                 | `https://api.kairogen.ai/oauth/token`                                                                              |
| `device_authorization_endpoint`  | **existe**: `https://api.kairogen.ai/oauth/device_authorization`                                                   |
| `registration_endpoint`          | **existe** (registro dinâmico): `https://api.kairogen.ai/oauth/register`                                           |
| `revocation_endpoint`            | `https://api.kairogen.ai/oauth/revoke`                                                                             |
| Outros                           | `introspection_endpoint`, `userinfo_endpoint`, `jwks_uri` (`/.well-known/jwks.json`)                               |
| Grant types                      | `authorization_code`, `refresh_token`, `urn:ietf:params:oauth:grant-type:device_code`                              |
| PKCE                             | `S256` (único método)                                                                                              |
| Autenticação no token endpoint   | `none` (cliente público) e `client_secret_post`                                                                    |
| Scopes                           | `openid`, `profile`, `email`, `kairogen:read`, `kairogen:generate`                                                 |
| Extras                           | `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true`              |
| `openid-configuration`           | idêntico ao `oauth-authorization-server`                                                                           |
| `WWW-Authenticate` sem token     | `Bearer realm=…, resource="https://mcp.kairogen.ai", resource_metadata=…, scope="kairogen:generate kairogen:read"` |
| Versão do protocolo MCP          | **não descoberta**: o servidor responde 401 antes de negociar. O cliente pede `2025-06-18` e aceita a que vier     |
| Documentação                     | `https://kairogen.ai/docs/mcp` respondeu **404** em 21/09/2026                                                     |

O próprio recurso publica uma dica (`kairogen_auth_hints`): code + PKCE para
clientes que recebem redirect, **device code para quem não recebe**. O Wings
System é um servidor atrás de login, então o caminho principal é o **device
flow**; o code + PKCE fica como segunda opção no mesmo cartão.

### O que a descoberta NÃO respondeu

- Se o **registro dinâmico aceita** um cliente novo com grant `device_code` (só
  tentando; a tentativa é o primeiro clique em "Conectar", feito por um Admin
  Master, não por este trabalho).
- Os **argumentos e o formato de resposta das 8 ferramentas**: `tools/list`
  exige token, e a documentação pública está fora do ar. Os **argumentos** foram
  lidos depois da conexão (seção "Ferramentas reais"); as respostas, ainda não.

## Como a conexão funciona (Onda 7b-1)

Configurações → **Integrações** (`/administracao/integracoes`), cartão
"Kairogen". Só quem tem `integrations.manage` (Admin Master) vê e usa.

1. **Conectar** descobre os endpoints, registra um cliente público
   ("Wings System", sem segredo) pelo registro dinâmico na primeira vez e inicia
   o **device flow**: a tela mostra um código e o botão "Abrir o Kairogen".
2. A pessoa entra no Kairogen com a conta da Wings e digita o código. A página
   confere sozinha, no ritmo que o Kairogen pediu (o servidor impõe o
   intervalo, e aumenta 5 s a cada `slow_down`).
3. Conectado, o cartão mostra saldo (`get_credits`), quem conectou, os scopes e
   as **ferramentas que o Kairogen oferece, com o esquema de argumentos de cada
   uma**. É daí que sai o formato real das 8 ferramentas para a Onda 7b-2.
4. Se o Kairogen recusar o device flow para este cliente, o cartão oferece
   "Conectar pelo navegador": authorization code + PKCE (S256), com retorno em
   `APP_BASE_URL/api/integrations/kairogen/callback`, conferindo `state` e `iss`.
5. **Desconectar** revoga o token no Kairogen (melhor esforço), apaga os tokens
   daqui e mantém o `client_id` registrado para a próxima conexão.

Se o registro dinâmico for recusado, registre o cliente à mão no Kairogen e
informe `KAIROGEN_CLIENT_ID`.

### Onde cada regra mora

| Regra                                  | Onde                                                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token nunca vai ao front nem ao modelo | `service.ts` não devolve token em nenhuma função; o status leva estado, saldo e código de usuário. Há teste procurando os tokens na resposta e na linha do banco     |
| Tokens criptografados                  | AES-256-GCM em `lib/secret-box.ts`, chave **própria** `INTEGRATIONS_ENCRYPTION_KEY`. Também cifrados: o `device_code` e o verificador PKCE enquanto pendentes        |
| Por que não a chave do CPF             | Vazou a chave das integrações: troca-se a chave e reconecta-se. A do CPF não se troca assim, e perdê-la perde todos os CPFs. A API recusa subir com chaves repetidas |
| Refresh automático                     | 60 s antes de expirar, sob trava na linha da conexão (o Kairogen pode girar o refresh token a cada uso). Kairogen fora do ar não derruba a conexão                   |
| Reconectar                             | refresh recusado marca `needs_reconnect` e o cartão pede para conectar de novo                                                                                       |
| Metadado não é verdade                 | todo endpoint descoberto precisa ser `https` em `*.kairogen.ai` e o `issuer` tem de bater                                                                            |
| Nunca repetir o que gasta crédito      | o cliente MCP só repete leitura (`list_models`, `estimate_cost`, `get_credits`, `get_generation`). Geração vai uma vez; se ninguém sabe se chegou, o erro diz isso   |
| Auditoria                              | `integrations.kairogen_connect_started`, `_connected`, `_connect_failed`, `_disconnected`, sem nenhum valor secreto                                                  |

**Parâmetros da estimativa na geração** (2026-09-24, GENERATION_QUOTE_MISMATCH no staging com gpt-image-2 em 2K: estimou 5, cobraria 3). `estimate_cost` declara `resolution` no topo; `generate_image` não, e o Kairogen descarta chave não declarada. Agora a geração reenvia exatamente os `priceArgs` guardados na estimativa, cada um onde a ferramenta lê (`pricedArgsFor`): chave declarada no topo, o resto em `extra_params`. O teste compara, chave por chave, o que foi estimado e o que foi enviado (`pricedParamsOf`). Parâmetro fora do `param_schema` do modelo é recusado antes de qualquer cartão, com a lista dos aceitos.

**Erro do próprio Kairogen numa leitura** (2026-09-24, visto no staging: `Kairogen API error (500): [INTERNAL_ERROR]` dentro da resposta da ferramenta, não como HTTP 500). `callKairogen` tenta a mesma leitura mais uma vez depois de 1,5 s (`KAIROGEN_TRANSIENT_RETRY_MS`); falhando de novo, vira `unavailable` ("O Kairogen não respondeu agora"), e não recusa do pedido. Erro 400 (`VALIDATION_ERROR`) não é repetido. Geração nunca é repetida. No agente, um provedor que falhou do lado dele não é chamado de novo na mesma resposta: a ferramenta devolve `problema_do_provedor` e o agente diz à pessoa que o problema é do provedor e oferece tentar mais tarde.

## Cliente MCP

`apps/api/src/lib/mcp-client`: JSON-RPC por POST, `Authorization: Bearer`,
resposta em JSON ou em `text/event-stream`, `Mcp-Session-Id` e
`MCP-Protocol-Version` depois do `initialize` (pede `2025-06-18` e usa a versão
que o servidor devolver). Timeout por chamada (30 s por padrão). O fake
roteirizado está em `modules/integrations/kairogen/fake-kairogen.ts`.

> ⚠️ **Os argumentos e resultados das 8 ferramentas no fake são suposição.** O
> que os testes provam é o transporte, o OAuth e as regras em volta. O formato
> real só aparece depois da primeira conexão, no próprio cartão.

## Biblioteca de mídia

Tabela `media_assets` (dono, origem `kairogen`/`upload`, prompt, modelo,
créditos, tipo, dimensões, duração, caminho no volume, cliente, pasta, tags) e
arquivos no volume. O tipo do arquivo vem dos **bytes**, nunca do nome nem do
cabeçalho. O nome no disco é gerado pelo servidor (`AAAA-MM/<uuid>.ext`).
Download só por `GET /media/assets/:id/file`, com login e
`marketing.media.read`; um arquivo cujo tamanho mudou, ou um caminho que saia
do volume, responde 404.

**Volume:** `MEDIA_DIR`. Sem ela, a biblioteca usa `CREATIVE_VIDEO_DIR/media`;
sem nenhuma das duas, as rotas de mídia respondem 503. Recomendação para quem
monta o volume: **um volume persistente só**, por exemplo em `/data`, com
`CREATIVE_VIDEO_DIR=/data/videos` e `MEDIA_DIR=/data/media`, em `wings-api` de
staging e de produção.

Permissões novas: `integrations.manage` (Admin Master), `marketing.media.read`
e `marketing.media.generate` (Admin Master, Diretoria, Marketing).

## Ferramentas reais (lidas em 21/09/2026, conta conectada no staging)

Conta conectada, plano **free**, 45 créditos, protocolo MCP **2025-06-18**,
scopes `kairogen:read` e `kairogen:generate`. Os esquemas completos, como o
`tools/list` devolveu, estão em [`kairogen-tools.json`](kairogen-tools.json)
(só nomes, descrições e esquemas; nenhum dado de conta). A leitura foi feita na
coluna `tools` da conexão, sem tocar nas colunas de credencial. O `wings_ro`
não tem permissão nessa tabela.

| Ferramenta                | Obrigatórios                                                       | O que importa para a 7b-2                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_models`             | nenhum (`type`, `search` opcionais)                                | cada modelo traz preço e `param_schema` com os parâmetros reais; é dali que sai o que o formulário mostra por modelo                                                        |
| `get_credits`             | nenhum                                                             | saldo da conta                                                                                                                                                              |
| `estimate_cost`           | `model`, **`plan_key`** (free, essential, pro, precision, creator) | precisa dos mesmos parâmetros que mexem no preço (`size`, `quality`, `resolution`, `duration_seconds`, `quantity`, `turbo`, `generate_audio`, `sound`, `extra_params`)      |
| `generate_image`          | `model`, `prompt`                                                  | `quantity` até 4, `aspect_ratio`, `size`, `quality`, `seed`, `negative_prompt`, `reference_image_urls`, **`expected_credits`**, `wait_for_completion` (padrão falso)        |
| `generate_video`          | `model`, `prompt`                                                  | `quantity` até 2, `duration_seconds` (tem de ser uma das durações do modelo), `resolution`, `first_frame_url`, `last_frame_url`, referências, **`expected_credits`**        |
| `animate_from_generation` | `generation_id`                                                    | anima uma imagem **já gerada no Kairogen**, pelo id da geração; `video_model` padrão `seedance-v2-0-image-to-video`; aqui `wait_for_completion` é **verdadeiro** por padrão |
| `upscale_image`           | `scale` (2 ou 4), `image_url`, `input_width`, `input_height`       | Topaz; `output_format` jpeg ou png; rosto opcional                                                                                                                          |
| `get_generation`          | `generation_id`                                                    | devolve o estado na hora (`wait_for_completion` falso por padrão); é o que o sistema usa para acompanhar o progresso                                                        |

Três coisas que mudam o desenho da 7b-2:

1. **`expected_credits`.** `generate_image` e `generate_video` aceitam o custo
   devolvido por `estimate_cost` e o Kairogen **recusa a geração se a cobrança
   real for diferente**. É a trava do lado deles para a nossa regra "nunca gerar
   sem estimar antes": o sistema sempre manda esse campo.
2. **`plan_key` é obrigatório em `estimate_cost`.** O plano é da conta (hoje
   free). Falta descobrir se `get_credits` informa o plano; se não informar,
   vira configuração.
3. **Referências e ampliação pedem URL pública.** `reference_image_urls`,
   `first_frame_url`, `last_frame_url` e o `image_url` do `upscale_image`
   precisam ser acessíveis ao Kairogen, e a biblioteca só serve arquivo com
   login. Para mídia **gerada no Kairogen** dá para guardar e reenviar a URL de
   saída deles, e "Animar" funciona só com o `generation_id`. Para **upload
   nosso**, usar como referência ou ampliar exige decidir entre um link
   assinado de vida curta ou não oferecer essas duas ações para uploads.

As descrições das ferramentas trazem orientação para clientes com widget de
chat (por exemplo, não chamar `get_generation` depois de gerar, porque o widget
acompanha sozinho). O Wings System não tem esse widget: quem acompanha o
progresso é o servidor, por `get_generation`. Essas descrições são dado de
terceiro, lidas como documentação, nunca como instrução.

O formato das **respostas** não é publicado; foi lido do log do staging em
2026-09-21 e está em "O formato real das respostas", abaixo.

## Edição de Fotos e Vídeos (Onda 7b-2)

Marketing → Edição de Fotos e Vídeos (`/marketing/edicao`): biblioteca,
formulário do operador e o chat do Agente de Edição Wings.

### A ordem das coisas, que o código não deixa pular

1. **Estimar.** `POST /media/estimates` valida o pedido contra o catálogo
   (`list_models`, cache de 1 h por plano) e chama `estimate_cost` com o
   **plano contratado** e os mesmos parâmetros de preço. Grava uma linha em
   `media_generations` no estado `estimated`, válida por 10 minutos.
2. **Clicar.** `POST /media/generations` aceita **só o id da estimativa**. Não
   existe rota que gere a partir de parâmetros: "nunca gerar sem estimar antes" é
   um fato do modelo de dados, não um hábito de quem chama.
3. **Conferir tetos e saldo**, sob trava, para dois cliques não caberem juntos
   no mesmo teto.
4. **Gravar o gasto no ledger antes de falar com o Kairogen.** Uma queda entre
   os dois deixa crédito contado que não foi gasto, nunca o contrário.
5. **Chamar o Kairogen uma vez**, com `expected_credits` igual ao estimado e
   `wait_for_completion: false` (também em `animate_from_generation`, cujo
   padrão é bloquear).
6. **Acompanhar** por `get_generation` com `wait_for_completion: false`, em
   intervalo crescente (5 s, 10 s, 15 s… até 30 s), por no máximo 20 minutos. A
   tela consulta `GET /media/generations/:id`; o servidor é quem fala com o
   Kairogen, e retoma o acompanhamento depois de um reinício.
7. **Guardar.** Cada saída é baixada para `MEDIA_DIR` e vira uma linha em
   `media_assets` com `external_generation_id` e `source_url`.

### O que acontece quando dá errado

| Situação                                           | Estado      | Créditos contados           | Repete sozinho? |
| -------------------------------------------------- | ----------- | --------------------------- | --------------- |
| Kairogen recusa (custo diverge, plano, parâmetros) | `refused`   | devolvidos                  | nunca           |
| Ninguém sabe se o pedido chegou (timeout, 5xx)     | `unknown`   | mantidos                    | nunca           |
| Kairogen informa falha                             | `failed`    | mantidos, ou o real se vier | nunca           |
| 20 minutos sem resposta final                      | `timed_out` | mantidos                    | nunca           |
| Concluiu e o real difere do estimado               | `succeeded` | corrigidos pela diferença   | —               |

A resposta do Kairogen numa recusa aparece na tela **como fala dele**
("Resposta dele: …"), depois de passar pelo filtro de dados sensíveis. Frases
como "retry with quantity=1" ou "never give up" são recado do fornecedor para
outros programas: o sistema mostra e não obedece.

### Tetos e ledger

`KAIROGEN_DAILY_CREDITS_PER_USER` (padrão 30) e `KAIROGEN_MONTHLY_CREDITS`
(padrão 500), no fuso de São Paulo, mais o saldo da conta. `media_credit_ledger`
é **só de inserção**: `estimated`, `started` (+estimado), `refused` (−estimado),
`succeeded`/`failed`/`timed_out`/`unknown` (correção pela cobrança real, quando
informada). Cada linha leva quem, quando, prompt, modelo, parâmetros, estimado,
real e o `generation_id`. Os tetos são somas de `credits_delta`.

### Links assinados

`reference_image_urls`, `first_frame_url` e o `image_url` do `upscale_image`
exigem endereço público. Para mídia **gerada no Kairogen** o sistema reenvia a
URL de origem deles. Para **upload nosso** emite
`APP_BASE_URL/api/media/public/<id>?sig=…`: um link por asset, 15 minutos,
HMAC-SHA256 com chave derivada de `INTEGRATIONS_ENCRYPTION_KEY` (não é a chave
que cifra os tokens), sem login, `Cache-Control: no-store`. Cada emissão fica em
`media_public_links` (asset, quem, para quê, quando vence). O endereço nunca
contém caminho do volume, e uma assinatura errada ou vencida responde 404 sem
dizer o motivo.

### Plano

`estimate_cost` exige `plan_key` e o Kairogen não informa o plano. O cartão de
Integrações tem "Plano contratado" (free, essential, pro, precision, creator;
padrão free; só `integrations.manage` edita; fica na auditoria). Trocar o plano
esvazia o cache do catálogo, porque o preço é por plano.

### Agente de Edição Wings

Mesma infra do Agente de Tráfego (OpenRouter, streaming, teto `AGENT_DAILY_USD`,
filtro de dados sensíveis, tabelas), com um **perfil por sub-módulo**
(`modules/agent/profile.ts`) e conversas separadas por `scope`. Quem tem
`marketing.media.read` conversa; gerar exige `marketing.media.generate`.

Ferramentas: `listar_modelos`, `estimar_custo`, `consultar_biblioteca`,
`consultar_saldo`, `rascunho_da_campanha` e `propor_geracao`. **Nenhuma gera.**
`propor_geracao` valida a proposta (prompt em inglês com pelo menos cena, luz,
enquadramento e estilo; explicação em português; regras de anúncio no prompt e
no texto da imagem), o **servidor** pede a estimativa e o cartão sai com
"Gerar (N créditos)". O clique chama a mesma `POST /media/generations`. Proposta
que não cabe nos tetos volta ao modelo com o valor. Nenhum token, endereço do
Kairogen, link assinado ou caminho de arquivo entra em resultado de ferramenta
(há teste procurando por eles no que o modelo recebeu).

### Ponte com o construtor

`POST /media/assets/:id/use-in-builder` (`ads.request` e
`marketing.media.read`) transforma uma mídia da biblioteca no criativo (imagem
PNG/JPEG, lado menor de 600 px, as mesmas regras do upload) ou no vídeo que o
construtor já sabe publicar, e a variação guarda `mediaAssetId`. O YouTube do
construtor recebe um **link**, não um arquivo, então não tem seletor.

### O formato real das respostas

Lido das linhas `kairogen answer shape` que a API do staging gravou em
2026-09-21 (segunda geração real: GPT-Image 1.5, 1 crédito, saldo 94 → 93). O
log guarda a **forma**: nomes das chaves, tipos e números; toda string aparece
só pelo tamanho. `modules/media/kairogen-adapter.ts` lê exatamente estes nomes,
e o Kairogen falso dos testes (`fake-kairogen.ts`) responde neste formato.

| Ferramenta       | Resposta                                                                                                                                                   | O que lemos                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `get_credits`    | `{ credits_remaining, stats: { creditsUsed, totalGenerations, totalImageGenerations, totalVideoGenerations, posts, likes, views, followers, following } }` | `credits_remaining`, e nenhum outro número                  |
| `estimate_cost`  | `{ model_key, credit_cost, quantity, plan_key, requested_params, params, breakdown, quote_note }`                                                          | `credit_cost`                                               |
| `generate_image` | `{ generation_id, generation_ids[], status: "QUEUED", model, output_urls: [], pending: true, poll_with, note }`                                            | `generation_id` (ou o primeiro de `generation_ids`)         |
| `get_generation` | `{ generation_id, status, output_urls[], model, prompt, aspect_ratio, cost_credits, pending, note?, reference_warning? }`                                  | `status`, `output_urls`, `cost_credits`, `pending`, o aviso |
| `list_models`    | `{ count, models[] }`, cada modelo como abaixo                                                                                                             | ver "Um modelo do catálogo"                                 |

Estados vistos em `get_generation`: `QUEUED`, `PROCESSING`, `COMPLETED`. Uma
geração só é dada por concluída com `COMPLETED` **e** endereço https em
`output_urls` (strings, host `cdn.kairogen.ai`). `pending: false` sem saída é
falha, qualquer que seja a palavra do estado.

Três coisas que esses nomes explicam:

- **O custo real nunca era gravado.** O campo é `cost_credits`; o leitor
  procurava `credits_charged`, `credit_cost` e outros. Agora `credits_charged`
  da geração e do ledger vêm de `cost_credits`.
- **O saldo.** `creditsFrom()` lê só `credits_remaining`. Não tira mais número
  de texto solto nem de outro campo (`stats.creditsUsed` é o total gasto, não o
  saldo). Entre as duas leituras do dia 21 o saldo foi 94 e depois 93, como
  devia. O salto anterior, de 45 para 94, aconteceu antes de haver registro e
  não tem como ser reconstituído; o próximo fica datado no ledger.
- **`reference_warning`.** Texto do Kairogen sobre o que ele fez com a imagem
  enviada. Quando a geração levou uma imagem, o texto aparece no cartão como
  fala dele ("Aviso do Kairogen sobre a imagem enviada: …"), filtrado e
  cortado em 300 caracteres. É dado, nunca instrução.

#### Um modelo do catálogo

```
{ model_key, name, type: "image" | "video", provider,
  default_mode, modes: { base: {…}, edit: { label, resolved_mode, required_inputs[],
                                           reference_field_keys[], auto_switch_on_reference } } | null,
  reference_inputs: [ { param_key, role, media, label, max_files, required, modes[] | null } ],
  supported_durations: number[] | null,
  param_schema: [ { key, type: "number" | "file" | …, label, required, default, min, max,
                    group, helpText, show, maxFiles, modes[], ui: {…}, tag } ],
  pricing: { baseCost, markupPercentage, currency: "BRL", unit: "per_generation",
             conditionalPricing: [ { condition, baseCost, markupPercentage, description } ],
             multiplyByQuantity },
  extra: { maxInputImages | maxReferenceImages, promptRequired } }
```

- **`param_schema` é uma lista de campos**, não um objeto `properties`. O leitor
  antigo esperava o objeto e por isso não via parâmetro nenhum: nenhum modelo
  "aceitava" imagem de referência e nenhum parâmetro de preço aparecia no
  formulário.
- **`pricing` é dinheiro, não créditos**: custo-base em BRL, percentual de
  markup e `conditionalPricing` (o mesmo, por condição). O catálogo não diz
  quantos créditos um modelo custa em plano nenhum, e a conversão de BRL para
  créditos não é publicada; adivinhá-la mostraria um preço que o Kairogen pode
  não cobrar. Ver "Preço por modelo no seletor".
- **O que o modelo faz com uma imagem** sai de `reference_inputs` e `modes`
  (`imageUse` no contrato): entrada de imagem aberta em todos os modos ou no
  modo padrão → `reference` (a imagem inspira uma nova); entrada que só existe
  no modo `edit` → `edit` (enviar a imagem **é** editá-la; o GPT Image é assim,
  com `auto_switch_on_reference: true`); sem entrada de imagem → não recebe
  imagem.

#### Preço por modelo no seletor

Como o catálogo não traz créditos, o servidor pergunta ao próprio Kairogen:
um `estimate_cost` por modelo, com o plano da conta, quantidade 1 e os
parâmetros padrão do modelo. É leitura: não gasta crédito, não cria estimativa
nem linha no ledger. Vale por uma hora junto com o catálogo, 4 chamadas por vez,
e a tela nunca espera mais de 8 segundos por isso (o que faltar continua sendo
preenchido no cache). O seletor mostra "N créditos por saída"; modelo que o
Kairogen não precifica assim (um vídeo que exige duração, uma falha) fica com
"custo na estimativa". O preço que vale continua sendo o de "Estimar custo",
com os parâmetros escolhidos.

`size`: quando as opções são proporções ("1:1"), o campo é o formato da imagem,
não um parâmetro de preço. Quando são pixels, o formulário oferece "Pelo formato
escolhido" como padrão e não envia `size`, porque no Kairogen um `size`
explícito passa por cima de `aspect_ratio`.

#### Imagem de referência e modo edição

No tipo Imagem o campo "Imagem de referência (opcional)" está sempre no
formulário: escolher da biblioteca ou enviar um arquivo na hora, que entra na
biblioteca no cliente do formulário (`POST /media/assets?clientId=`). Com uma
imagem escolhida, a pessoa diz o que fazer com ela: **como referência para uma
imagem nova** ou **editar esta imagem**. Se o modelo na tela não faz isso
(`imageUse` diferente), o formulário avisa, não deixa estimar e oferece os
modelos que fazem, com um clique para trocar. O servidor confere de novo na
estimativa e recusa com a mesma frase.

A imagem vai ao Kairogen em `reference_image_urls`, por link assinado de 15
minutos (ou pelo endereço do próprio Kairogen, quando a imagem veio de lá).
Nenhum parâmetro de "modo" é enviado: não existe esse argumento em
`generate_image`, e no modelo que só edita é a própria imagem que troca o modo.
`expected_credits` continua valendo: se editar custar diferente do estimado, o
Kairogen recusa e nada é cobrado.

O agente recebe `uso_de_imagem` em `listar_modelos`; num pedido "a partir desta
imagem" ele acha a mídia em `consultar_biblioteca`, escolhe um modelo que faça o
que foi pedido e informa `referenceAssetId` e `referenceUse`. Proposta com
modelo que não faz volta para ele com a lista dos que fazem. O cartão mostra a
miniatura da imagem que vai junto e o que será feito com ela.

#### O que o log ainda não mostrou

`shapeOf()` passou a manter o vocabulário de um esquema (chave de parâmetro,
`role`, `media`, nomes de modo) e a mostrar por inteiro `param_schema`,
`conditionalPricing`, `reference_inputs` e `options`. A próxima abertura da tela
no staging grava isso e fecha os pontos de "Não verificado".

### O saldo no ledger

`media_credit_ledger.balance_reported` guarda o que `get_credits` respondeu:

- em cada linha de uma geração (`estimated`, `started` e a linha final, esta com
  o saldo lido **depois** de terminar): a diferença entre `started` e a final é
  o que realmente saiu da conta;
- numa linha própria, `balance_changed` (sem geração, delta zero, com quem
  estava olhando), sempre que uma leitura difere da última registrada. Leituras
  que repetem o último valor não escrevem nada.

Um salto como 45 → 94 passa a ter data e a ficar entre duas linhas conhecidas.

### Para quem: clientes

Toda geração é para um cliente (`clients`: id, nome, slug, ativo), e a Wings
Company é o primeiro, com id fixo, criado pela migração. `client_id` fica em
`media_generations`, em cada linha do `media_credit_ledger` e em
`media_assets`; a proposta do agente leva `clientId` no payload. Ampliar ou
animar herda o cliente da imagem de origem. O cadastro fica em Administração →
Clientes (`clients.manage`: Admin Master, Diretoria, Marketing); a Wings Company
não pode ser renomeada nem desativada, e cliente inativo não recebe trabalho
novo.

**O nome do cliente nunca vai ao Kairogen.** `client_id` não faz parte de
`price_args` nem dos argumentos de nenhuma ferramenta, e uma estimativa cujo
prompt cite o nome do cliente escolhido é recusada antes de qualquer chamada
(`mentionsClient`, sem diferença de maiúsculas, acentos ou pontuação). A Wings
Company é a exceção: o próprio nome não é segredo. O agente lê
`listar_clientes`, pergunta "Para qual cliente?" quando o pedido não diz (a
proposta sem `clientId` volta para ele com essa instrução) e o cartão mostra
"Para quem".

A coluna de texto livre `media_assets.client`, de antes, não é mais lida nem
escrita.

## Roteiro do primeiro teste real

Uma imagem, uma saída, no modelo mais barato, com os créditos grátis. Quem
clica é o Eric.

1. Em Administração → Integrações, confira "Plano contratado: Free" e o saldo.
2. Abra Marketing → Edição de fotos e vídeos. O cabeçalho deve mostrar saldo,
   plano e os dois usos em zero.
3. No formulário: tipo **Imagem**; no seletor de modelo escolha o de **menor
   número de créditos por saída**; formato 1:1; quantidade 1; um prompt simples
   em inglês, sem texto na imagem.
4. **Estimar custo.** Confira se o número bate com o do seletor e se cabe no
   saldo. Se aparecer "O Kairogen respondeu sem um custo em créditos", pare: o
   formato da resposta é outro e o ajuste é no adaptador.
5. **Gerar (N créditos).** O cartão de progresso deve passar por "Gerando no
   Kairogen", "Salvando na biblioteca" e "Concluída", e a imagem aparecer na
   grade.
6. Confira o saldo no cartão de Integrações e no próprio Kairogen: a queda tem
   de ser igual ao estimado.
7. Qualquer estado diferente de "Concluída" é para parar e me mandar o texto do
   cartão. **Não clique de novo em "Resultado desconhecido"** sem olhar no
   Kairogen se a geração existe.

## Não verificado

- [ ] O nome da lista de opções de um parâmetro `select` em `param_schema`
      (o log mostrou um campo `number` e um `file`). O leitor aceita `options`,
      `enum` ou `values`, com valores simples ou `{ value }`.
- [ ] A palavra de `status` numa falha (só vimos `QUEUED`, `PROCESSING`,
      `COMPLETED`). `pending: false` sem saída já é tratado como falha.
- [ ] A forma de `conditionalPricing[].condition` (ficou além da profundidade
      que o log mostrava). Não é usada: o preço vem de `estimate_cost`.
- [ ] Os valores de `role` e `media` em `reference_inputs`. O leitor trata como
      imagem a entrada cujo `media` é `image` ou está ausente.
- [ ] Se editar (imagem enviada a um modelo com `modes.edit`) custa o mesmo que
      gerar. `expected_credits` protege: se diferir, o Kairogen recusa sem cobrar.
- [ ] As respostas de `generate_video`, `upscale_image` e
      `animate_from_generation` (nenhuma foi chamada de verdade ainda).
- [ ] Se os modelos aceitam `aspect_ratio: '4:5'`. Quando o catálogo informa os
      formatos aceitos, a estimativa já recusa o que o modelo não faz.
- [ ] Se o catálogo lista o ampliador (Topaz) com preço. Sem isso "Ampliar"
      responde que não pode ser estimado, e nada é gerado.
- [ ] Se o Kairogen devolve créditos numa geração que falha.
- [ ] Vídeos grandes: a saída é baixada inteira para a memória antes de gravar
      (limite de 150 MB).

#### Edição com imagem: o `estimate_cost` não sabe o preço (verificado 2026-09-24)

Lido do Kairogen real, de dentro da API de staging (só `list_models` e
`estimate_cost`, nada gerado): o `gpt-image-2` não tem `conditionalPricing`, e o
`estimate_cost` responde **3 créditos** (free, 1k, 1:1) com ou sem
`extra_params` `mode: "edit"`, `resolved_mode: "edit"`, `images: [url]` ou
`reference_image_urls`. O `estimate_cost` não declara argumento de imagem. Já a
geração com `reference_image_urls` entra no modo edit (`auto_switch_on_reference`)
e custa **4**. O Kairogen recusa com `GENERATION_QUOTE_MISMATCH` ("O custo desta
geração mudou para 4 créditos"), sem gerar e sem cobrar.

Não há payload de estimativa que acerte esse preço. A recusa passou a nomear o preço real:
`requotedCreditsFrom()` o lê, a geração fica `refused` (crédito devolvido no
ledger), e o servidor grava **uma nova estimativa** com esse preço e exatamente o
mesmo pedido e os mesmos parâmetros de preço (`requote` na resposta de
`POST /media/generations`). O botão passa a mostrar "Gerar (4 créditos)" com o
motivo, e gastar é um novo clique. Nada é reenviado sozinho: a chamada recusada
não custou nada, e a próxima só sai com o clique de uma pessoa no preço novo.

#### Plano contratado e modelos liberados (2026-09-24)

Nem `list_models` nem `get_credits` informam o plano de um modelo (lido do
Kairogen real em 2026-09-24: o catálogo só tem `model_key, name, type,
provider, default_mode, modes, reference_inputs, supported_durations,
param_schema, pricing, extra`). A regra fica em `kairogenMinimumPlan()`
(`packages/shared`), tirada da seção de planos de kairogen.ai:

- **Free:** todos os modelos de imagem, menos Topaz (o gpt-image-2 gerou no Free).
  Vídeo não ("The video model … is not available on the Free plan", recusa real).
- **Essential:** + vídeo Wan 2.6, Grok Imagine v1, Seedance V1.5 Pro, Veo 3.1 Lite.
- **Pro, Precision, Creator:** tudo, inclusive Sora, Veo Pro, Kling, Seedance 2.0 e Topaz.

Não verificado: o Free liberar todos os modelos de imagem (só o gpt-image-2
foi visto gerando), e os vídeos que o site não lista pelo nome (tratados como
Pro).

**A palavra do Kairogen vale mais que a tabela.** Uma recusa
`PLAN_UPGRADE_REQUIRED` na geração fica no `detail` da geração (com o código),
e dali em diante o catálogo marca o modelo como fechado no plano atual (pelo
menos o plano seguinte). O plano vem de "Plano contratado" em Integrações.

Um modelo fechado vem com `planRequired` no catálogo: o formulário mostra
"exige plano Pro" desabilitado, o agente o recebe em `fora_do_plano_contratado`
e não pode propô-lo, e a estimativa é recusada (`plan_required`) antes de
qualquer chamada ao Kairogen. Se a recusa vier na geração, o texto diz qual
plano libera.
