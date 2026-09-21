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
- Os **argumentos e o formato de resposta das 8 ferramentas** (`list_models`,
  `estimate_cost`, `get_credits`, `generate_image`, `generate_video`,
  `animate_from_generation`, `upscale_image`, `get_generation`): `tools/list`
  exige token, e a documentação pública está fora do ar.

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

## O que fica para a Onda 7b-2

Tela de Edição de Fotos e Vídeos, geração com estimativa antes, tetos e ledger
de créditos, chat do Agente de Edição e a ponte com o construtor. Dependem do
formato real das ferramentas, que só dá para ler depois de conectar.
