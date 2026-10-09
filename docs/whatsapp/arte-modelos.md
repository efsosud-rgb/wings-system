# Arte nos modelos do WhatsApp e envio pela janela de 24 h

Plano aprovado pelo Eric em 09/10/2026 (`/root/relatorios/whatsapp-oficial/plano-arte-modelos.md`). Cada marca de
Expansão sai com a própria logo no cabeçalho dos modelos; a Formatação sai com a arte da Wings. Dentro da janela de
24 h, o modelo escolhido vira mensagem comum. Migração **0081**.

## A arte

- **Onde se cadastra:** na ficha da marca (Formatação → Clientes → a marca, quadro "WhatsApp da marca", para marcas
  de Expansão ou "ambos"), por quem preenche a ficha (`clients.edit`). A arte da Wings fica em Administração →
  Clientes, no quadro "Arte do WhatsApp da Wings", por quem cuida do cadastro (`clients.manage`); ela é a arte do
  registro Wings Company (`clients.whatsapp_art_file_id` da linha da Wings).
- **Arquivo:** PNG ou JPEG, **1125 × 600**, até **2 MB**. A tela confere antes de enviar; o navegador manda os bytes
  direto para o armazenamento (endereço assinado de 15 minutos, tipo e tamanho exatos); o servidor então lê o
  arquivo e confere o tipo **pelo conteúdo** e as dimensões pelo cabeçalho do PNG (IHDR) ou do JPEG (SOF), sem
  biblioteca (`lib/image-header.ts`). Fora da regra: o arquivo é apagado do armazenamento e a resposta é 422
  `art_refused` com o motivo (`type`, `size`, `dimensions`, `unreadable`, `mismatch`).
- **No Drive:** o arquivo aceito vira um arquivo da pasta Mídia da marca (`Clientes/<NN. Nome>/08 Marketing/Mídia`;
  a da Wings em `Formatação/Marketing/Mídia`), chamado "Arte do WhatsApp AAAA-MM-DD.png", com `sha256`. Trocar a
  arte não apaga a anterior; "Tirar a arte" só desliga a marca do arquivo. Arquivo na lixeira conta como "sem arte".
- **Auditoria (por id):** `client.whatsapp_art_upload_requested`, `client.whatsapp_art_set` (`fileId`,
  `previousFileId`), `client.whatsapp_art_refused` (motivo), `client.whatsapp_art_removed`,
  `client.whatsapp_article_set`, e `drive.file_uploaded`/`drive.file_previewed` com `purpose`.
- **Aviso:** a ficha mostra "Cadastre a arte do WhatsApp desta marca"; a lista de clientes marca
  "WhatsApp: falta a arte / o artigo"; o vendedor vê o mesmo aviso na prévia do modelo.

## O artigo

- **Marca:** campo "Artigo do nome nos modelos" (o/a) na mesma ficha. Nas versões `_arte`, a variável da marca já
  leva a preposição: "do time de expansão {{3}}" ← "da Malkuth" / "do Casal do Churros". Sem artigo cadastrado vai
  "da", com aviso para cadastrar.
- **Empresa do lead (Formatação):** feminino por padrão ("transformar a Padaria Pão Dourado", "da Padaria…"); o
  vendedor troca para masculino na prévia ("o Bar do Zé").
- **Texto antigo:** quando o texto do modelo já tem "da/do/a/o" logo antes do `{{n}}` (os três `_arte` da conta de
  teste criados com o texto antigo), o nome vai sem artigo: nunca "da da Malkuth" (`waFieldForm`).

## Os campos de cada modelo

`WA_TEMPLATE_FIELDS` (`packages/shared/src/whatsapp-art.ts`) diz o que é cada `{{n}}`: nome do lead (primeiro
nome), nome de quem envia, marca, empresa do lead, ou campo livre (dia, hora, link). Foi montada a partir dos
textos e exemplos enviados à Meta em 07/10 (`modelos-whatsapp-2026-10-07.json` e `modelos-arte-12-2026-10-07.json`).
**A conferir com a lista do Sonnet.** Um modelo fora da tabela tem só campos livres, digitados como vão. A marca de
uma conversa de marca é sempre a da conversa (campo travado na tela).

## O que sai (`modules/whatsapp/template-send.ts`)

Uma função só (`planTemplate`), usada pela prévia e pelo envio, e pronta para a retomada da Sofia
(`sofia_*_retomar_atendimento`), que ainda não envia modelo.

- **Janela de 24 h aberta:** o modelo vira mensagem comum, com o texto igual e as variáveis preenchidas:
  - botões de resposta (até 3, títulos de até 20 caracteres) → `interactive` `button`;
  - um único botão de link → `interactive` `cta_url`;
  - sem botões → a arte com o texto embaixo (`image` com legenda) ou texto;
  - a arte vai no cabeçalho (`header` imagem, pelo id da mídia); o rodapé vai como rodapé.
  - Link junto com respostas, botão de ligar, código, mais de 3 botões, título longo, link com parte variável ou
    cabeçalho de vídeo/documento: sai **como modelo**, e a tela diz por quê.
- **Janela fechada:** sai o modelo aprovado. A versão `<nome>_arte`, com a imagem no componente `header`, quando
  a arte está cadastrada e essa versão está aprovada; senão, o modelo atual (com aviso). Um modelo que só existe
  com arte e não tem arte cadastrada é recusado (422 `art_missing`).
- **A arte segue a voz:** conversa de marca → a arte da marca; conversa da Wings → a arte da Wings. Numa marca
  nunca vai a arte da Wings, e a voz da marca (nada com "Wings") vale também para a mensagem comum feita do
  modelo (texto, botões, rodapé e cabeçalho: 422 `brand_voice`).
- **Pedido para parar:** quem pediu para não receber mensagens não recebe modelo, nem como mensagem comum.
- **Custo na tela:** "Mensagem comum, sem custo (janela aberta até HH:MM)" ou "Modelo aprovado (marketing:
  cobrado pela Meta)". Modelo de utilidade dentro da janela aparece como sem custo (regra da Meta desde 07/2025).
  "Sem custo" vale dentro das 1.000 mensagens de atendimento grátis por número por mês (ver custos em
  `cloud-api.md`); **não conferido na fatura**.
- **Registro:** modelo → `content.template`; mensagem comum → `content.fromTemplate` (a bolha mostra "Do modelo
  X, como mensagem comum"); com arte → `content.art` (`fileId`, `mediaId`). A auditoria `whatsapp.message_sent`
  leva `template`, `sentAs` e `artFileId`.

## A arte na Meta (`wa_media_uploads`)

`POST /{phone-number-id}/media` (multipart) uma vez por arte e número; o id fica guardado com a data e a versão do
arquivo. Sobe de novo quando passa de **25 dias** (a Meta guarda 30), quando o arquivo do Drive mudou de versão, ou
quando a Meta responde a um envio com um erro de mídia (códigos 100, 131009, 131052, 131053, na hora ou depois,
pelo webhook): o id é marcado inválido e o **próximo** envio sobe a arte. O envio que falhou fica falho; nada é
repetido sozinho. Se a arte não sobe, o envio é recusado antes (502 `art_upload_failed`) e nada é gravado.

## Rotas novas

| Rota                                                                            | O quê                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------- |
| `GET /clients/:id/whatsapp`                                                     | Arte (endereço de 5 min) e artigo da marca          |
| `PUT /clients/:id/whatsapp/article`                                             | `{ article: 'o' \| 'a' \| null }` (a Wings não tem) |
| `POST /clients/:id/whatsapp/art/uploads`                                        | `{ mimeType, byteSize }` → endereço de envio        |
| `POST /clients/:id/whatsapp/art/uploads/:uploadId/complete`                     | Confere e grava a arte                              |
| `DELETE /clients/:id/whatsapp/art`                                              | Tira a arte (o arquivo fica no Drive)               |
| `POST /leads/:id/whatsapp/template-preview` (e `/whatsapp/conversations/:id/…`) | O que o modelo vira agora, com os campos            |
| `GET /leads/:id/whatsapp/art` (e `/whatsapp/conversations/:id/art`)             | A arte da conversa, endereço de 5 min               |

A prévia e a arte da conversa seguem a regra da negociação (`leads.whatsapp` no escopo do dono): vendedor de outra
negociação recebe 404. `POST …/template` aceita `{ name, language, params, companyArticle }`, com os nomes **sem**
artigo; o servidor monta tudo de novo.

## Carga das artes (`carregar-artes.sh`)

`/root/relatorios/artes-marcas/carregar-artes.sh <staging|producao> <estado|simular|aplicar|desfazer LOTE>`, que
roda `node dist/scripts/brand-art.js` dentro do contêiner da API (`pnpm --filter @wings/api whatsapp:brand-art`
local). Casa `<slug>.png` com a marca (exceções em `FILE_SLUG_EXCEPTIONS`), confere cada arquivo como a tela,
grava no Drive e na marca, com auditoria por id. `wings.png` (ou a arte de exemplo da Wings) é a arte da Wings;
`artigos.tsv` (slug, TAB, o/a) grava os artigos.

- `estado`: cada marca com arte ou sem, cada arquivo com a sua marca ou "sem marca", o que falta e os lotes.
- `simular`: o que mudaria (nova, troca, igual, recusada e por quê); não grava.
- `aplicar`: só depois de um `simular` do mesmo alvo e dos mesmos arquivos há menos de 24 h e sem recusa; pede
  STAGING ou PRODUCAO digitado; grava num lote `artes-AAAAMMDDTHHMMSSZ` com o que cada marca tinha em
  `ops.brand_art_runs`/`ops.brand_art_changes`.
- `desfazer LOTE`: mostra e, confirmado, devolve a arte e o artigo de antes às marcas que não mudaram depois do
  lote. Nenhum arquivo é apagado.

Produção: só o Eric, com PRODUCAO (e `WINGS_ALLOW_PRODUCTION=1` quando rodado pelo Claude).

## Não verificado ao vivo

Nenhuma mensagem real saiu: os testes usam a Meta simulada. Não conferidos contra a Meta: o upload multipart de
mídia, o `interactive` com cabeçalho de imagem e rodapé, o `cta_url`, a imagem por id no `header` do modelo, e os
códigos exatos de erro de mídia vencida. O primeiro teste é do Eric, com o número de teste, quando ele pedir.
