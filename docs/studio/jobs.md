# Wings Studio — job de render (contrato)

O editor exporta no navegador (WebCodecs). Quando isso falha, é lento demais
ou o navegador não tem WebCodecs, a API enfileira um job de **render** na
tabela `jobs` (migração de `apps/api`, fila de `apps/worker`), e o worker
produz o arquivo com FFmpeg e o grava no storage do Drive. Este documento é o
contrato entre os dois: o que entra no job, o que sai, e como uma falha é
contada. O worker não conhece as tabelas do Drive nem as rotas da API; a API
não conhece o FFmpeg.

Três regras valem para todo job:

1. **Nada de caminho, chave ou URL no que o navegador vê.** O projeto que a
   tela salva e abre cita arquivos por `wings-drive://<id do drive_files>`. A
   API traduz esses ids para `storage_key` na hora de enfileirar, e só o
   worker lê essa tradução.
2. **Um job é uma tentativa.** Render é caro: `attempts` máximo 1. Falhou,
   fica `failed` e a pessoa pede de novo pela tela. O worker nunca repete
   sozinho.
3. **`error` é um código e uma frase**, nunca nome de arquivo, chave, prompt
   ou nome de cliente.

## Linha em `jobs`

| Coluna   | Valor                                                                   |
| -------- | ----------------------------------------------------------------------- |
| `type`   | `render`                                                                |
| `state`  | `pending` → `running` → `done` ou `failed`                              |
| `input`  | o objeto abaixo, escrito pela API                                       |
| `output` | o objeto de saída, escrito pelo worker; a API acrescenta `filed` depois |
| `error`  | `<código>: <frase>` (ver códigos)                                       |

Quem enfileira é sempre a API (`POST /studio/renders`, `marketing.media.edit`
e acesso de escrita no Drive à pasta de destino). O navegador nunca escreve na
tabela.

## `input` (versão 1)

```json
{
  "version": 1,
  "project": { "...": "o projeto do editor, formato abaixo" },
  "assets": {
    "5b0c…": {
      "storageKey": "drive/2026-09/8f1e…",
      "mimeType": "video/mp4",
      "byteSize": 734003200
    },
    "a91d…": { "storageKey": "drive/2026-09/c0aa…", "mimeType": "image/png", "byteSize": 51200 }
  },
  "output": {
    "storageKey": "drive/2026-09/1d2e…",
    "container": "mp4",
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "videoBitrate": 8000000,
    "audioBitrate": 192000
  },
  "destination": {
    "folderId": "…",
    "name": "corte-final.mp4",
    "replaceFileId": null,
    "clientId": "…",
    "ownerId": "…"
  }
}
```

- `project`: o JSON do editor (esquema _Edit_ do núcleo em `packages/studio`,
  o mesmo que a tela salva no Drive como `<nome>.wings-studio.json`). Todo
  `asset.src` é `wings-drive://<id>`; um `src` com `http` ou qualquer outro
  esquema faz o job falhar antes de baixar qualquer coisa
  (`invalid_project`).
- `assets`: um item por id citado em `project`. `storageKey` é a chave no
  bucket do Drive; `byteSize` é conferido com `HEAD` antes de baixar.
- `output.storageKey`: onde o worker grava o resultado. A API escolhe a chave
  (`drive/AAAA-MM/<uuid>`); o worker nunca inventa chave nem grava em outra.
- `output.width/height/fps`: o formato final (16:9 → 1920×1080, 9:16 →
  1080×1920, 1:1 → 1080×1080). `videoBitrate` e `audioBitrate` em bits por
  segundo; o navegador exporta a 5 Mbps, o servidor a 8 Mbps por padrão.
- `destination`: **o worker não lê**. É o que a API precisa para criar o
  `drive_files` quando o job termina (pasta, nome, versão a substituir,
  cliente, dono). Fica no `input` para o job ser autossuficiente depois de um
  reinício da API.

### O que o worker precisa renderizar (parte 1)

O esquema do editor é grande. O worker cobre este subconjunto, e o que sobra
vai para `output.unsupported`:

| Elemento                             | Como                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| Faixas (`timeline.tracks[]`)         | a primeira faixa é a de cima; compõem-se de baixo para cima                                   |
| Clipe de vídeo (`asset.type: video`) | `start`, `length`, `asset.trim`, `asset.volume`, `fit` (`crop`, `contain`, `cover`), `scale`  |
| Clipe de áudio (`audio`)             | `start`, `length`, `asset.trim`, `asset.volume`, mixado por cima                              |
| Clipe de imagem (`image`)            | como vídeo, sem áudio (é o caso do logo)                                                      |
| Texto (`rich-text` e `text`)         | texto, fonte por nome (só as que o worker tem instaladas), tamanho, cor, alinhamento, posição |
| Legenda (`caption`)                  | `asset.src` SRT/VTT do Drive (`wings-drive://`), estilo básico (fonte, tamanho, cor, fundo)   |
| Transição (`transition.in`/`out`)    | `fade` e `fadeSlow`/`fadeFast`; qualquer outra vira corte seco e entra em `unsupported`       |
| Posição (`position`, `offset`)       | as nove posições e o deslocamento                                                             |
| Opacidade (`opacity`)                | fixa por clipe; keyframes viram o primeiro valor e entram em `unsupported`                    |
| Fundo (`timeline.background`)        | cor sólida                                                                                    |

Fora disso (HTML, formas, luma, filtros, efeitos de movimento, animação de
palavras nas legendas, merge fields): o worker **não** tenta imitar. Se o
elemento é decorativo, ele é omitido e listado em `unsupported`; se a omissão
muda o conteúdo (um clipe inteiro que não dá para decodificar, uma legenda
cujo arquivo não existe), o job **falha**.

## `output`

Escrito pelo worker ao terminar:

```json
{
  "storageKey": "drive/2026-09/1d2e…",
  "byteSize": 48211230,
  "checksum": "sha256:…",
  "mimeType": "video/mp4",
  "width": 1080,
  "height": 1920,
  "fps": 30,
  "durationSeconds": 47.2,
  "unsupported": ["track 1 clip 2: transition wipeLeft rendered as cut"],
  "renderSeconds": 93.4
}
```

`unsupported` são frases curtas, por posição na linha do tempo (faixa e
clipe), nunca por nome de arquivo. A tela mostra a lista como aviso ao lado do
arquivo pronto.

Depois de ver `state = done`, a API confere com `HEAD` que o objeto existe com
o `byteSize` prometido, cria o `drive_files` (ou a nova versão, quando há
`replaceFileId`) na pasta de `destination`, audita `studio.render_saved` (id
do job, id do arquivo) e grava em `output.filed`:

```json
{ "filed": { "driveFileId": "…", "version": 2, "at": "2026-09-22T14:03:11Z" } }
```

Isso acontece uma vez, sob trava na linha (`select … for update`), na primeira
consulta de `GET /studio/renders/:id` que encontrar o job terminado. Objeto que
não está lá, ou com tamanho diferente, vira `failed` com `output_missing`.

## Códigos de erro

| Código              | Quando                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| `invalid_project`   | JSON fora do esquema, `src` que não é `wings-drive://`, id sem `assets` |
| `asset_missing`     | `HEAD` no storage não achou o objeto ou o tamanho difere                |
| `asset_undecodable` | FFmpeg não abre o arquivo                                               |
| `too_long`          | duração total acima de `RENDER_MAX_SECONDS` (padrão 3600)               |
| `render_failed`     | FFmpeg terminou com erro                                                |
| `timeout`           | passou de `RENDER_TIMEOUT_SECONDS` (padrão 7200)                        |
| `output_missing`    | (API) o objeto prometido não estava no storage ao arquivar              |

Formato de `error`: `render_failed: ffmpeg exited with status 1`. Sem stack,
sem stderr inteiro (o stderr do FFmpeg traz o caminho do arquivo temporário).

## Limites

| Variável (worker)        | Padrão        | Para quê                                                                              |
| ------------------------ | ------------- | ------------------------------------------------------------------------------------- |
| `RENDER_MAX_SECONDS`     | 3600          | duração máxima do resultado                                                           |
| `RENDER_TIMEOUT_SECONDS` | 7200          | tempo máximo de uma tentativa                                                         |
| `RENDER_MAX_INPUT_BYTES` | 8 GiB         | soma dos `byteSize` de `assets`                                                       |
| `RENDER_TMP_DIR`         | `os.tmpdir()` | os arquivos baixados e o resultado ficam aqui e são apagados no fim, sucesso ou falha |

Nenhum limite é imposto pela API além de `DRIVE_MAX_FILE_BYTES` no arquivo
final.

## O que a tela faz

1. "Exportar" tenta no navegador. Sem WebCodecs, ou se a estimativa passa de
   `STUDIO_BROWSER_EXPORT_MAX_SECONDS` (padrão 600 s de linha do tempo), a tela
   oferece "Renderizar no servidor" direto.
2. Falha ou cancelamento no navegador também oferecem o servidor.
3. `POST /studio/renders` responde `202` com o id do job; a tela consulta
   `GET /studio/renders/:id` a cada 5 s e mostra `pending` ("na fila"),
   `running` ("renderizando"), `done` (com o arquivo no Drive e a lista de
   `unsupported`) ou `failed` (com a frase do erro).

## Legendas (`type: transcribe`)

O botão "Legendar" do Studio manda um vídeo ou áudio do Drive para o Whisper
do worker (`faster-whisper`, modelo "small"). Mesmas três regras dos jobs.

| Coluna   | Valor                                                                    |
| -------- | ------------------------------------------------------------------------ |
| `type`   | `transcribe`                                                             |
| `input`  | `{ version: 1, storageKey, language?, destination }`                     |
| `output` | o que o worker devolve; a API acrescenta `filed`, `language`, `segments` |
| `error`  | `<código>: <frase>`                                                      |

Quem enfileira é `POST /studio/transcriptions` (`{ fileId, language? }`,
`marketing.media.edit`): o arquivo precisa ser `video/*` ou `audio/*`
(senão `422 unsupported_file`), ler é o bastante para citá-lo, e a pasta dele
precisa de acesso de escrita, porque o SRT nasce ao lado. O worker só lê
`storageKey` e `language` (ISO 639-1; sem ela detecta); `destination`
(`folderId`, `name` = `<nome sem extensão>.srt`, `sourceFileId`, `clientId`,
`ownerId`) é da API, para o job continuar autossuficiente depois de um
reinício. A resposta é `202 { transcription }`, auditada como
`studio.captions_requested` (id do job, id do arquivo, idioma).

O worker grava o JSON da transcrição (`{ language, languageProbability,
segments: [{ start, end, text }] }`) em `<storageKey sem extensão>.transcript.json`
e devolve `output.outputStorageKey` mais `language`, `languageProbability`,
`durationSeconds` e `segments`.

Na primeira `GET /studio/transcriptions/:id` que encontra o job `done`
(só o dono vê; `select … for update` na prática é a mesma atualização
condicional dos renders), a API lê esse JSON, monta o SRT (`segmentsToSrt`,
em `packages/shared`: cues numeradas, `HH:MM:SS,mmm`, texto vazio pulado, fim
nunca antes de início + 0,5 s), grava o SRT no storage com chave nova e cria
o `drive_files` `<nome>.srt` na pasta da origem, **como nova versão** quando já
existe um arquivo com esse nome. Audita `studio.captions_saved` (id do job,
id do arquivo, número de cues) e guarda `output.filed = { driveFileId,
version, name, at }`. JSON que não está no storage ou não tem `segments` vira
`failed` com `output_missing`.

O que a tela recebe (`StudioTranscription`): `id`, `state`, `error`,
`sourceFileId`, `file: { id, version, name, folderId } | null`, `language`,
`segments` (quantidade), `createdAt`, `finishedAt`. Com `file`, a tela põe um
clipe `caption` citando `wings-drive://<file.id>`.

## Parte 2

- Proxy de baixa resolução (`type: proxy`): 540p H.264, gravado como
  `drive/proxy/<id do arquivo>`, para o editor abrir vídeo de uma hora sem
  engasgar. O projeto continua citando o original.
- Render no servidor com o mesmo motor do navegador (Chromium sem tela
  rodando `packages/studio`), para cobrir o esquema inteiro sem reimplementar
  em FFmpeg.
