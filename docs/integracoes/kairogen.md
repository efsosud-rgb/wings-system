# Kairogen (geração de imagem e vídeo) — integração

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

**Ainda desconhecido:** o formato das **respostas** (campos do resultado de
`generate_*` e `get_generation`, URLs de saída, custo real, estados possíveis) e
o conteúdo de `list_models` (modelos, preços, `param_schema`). `list_models` e
`get_credits` são leitura e não gastam crédito; uma chamada de cada, feita pela
conexão do staging, responde isso antes de codar.

## O que fica para a Onda 7b-2

Tela de Edição de Fotos e Vídeos, geração com estimativa antes, tetos e ledger
de créditos, chat do Agente de Edição e a ponte com o construtor. Dependem do
formato real das ferramentas, que só dá para ler depois de conectar.
