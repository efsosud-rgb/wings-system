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
| `worker_lost`       | o worker parou no meio do job (ver "Job abandonado")                    |

Formato de `error`: `render_failed: ffmpeg exited with status 1`. Sem stack,
sem stderr inteiro (o stderr do FFmpeg traz o caminho do arquivo temporário).

## Job abandonado

O worker grava `heartbeat_at` ao pegar o job e a cada 30 s enquanto ele roda.
Se o processo morre (OOM, deploy, reinício do container), o job fica
`running` e o heartbeat para. Todo worker procura, a cada minuto, jobs dos
tipos que ele atende sem heartbeat há mais de:

| Tipo          | Sem heartbeat há |
| ------------- | ---------------- |
| `ffprobe`     | 2 min            |
| `transcribe`  | 5 min            |
| `render`      | 5 min            |
| `enrich_lead` | 5 min            |

O trabalho pesado roda em processo filho (FFmpeg, Whisper), então esses
tempos só precisam cobrir um event loop ocupado e um banco lento, não a
duração do job. Linha pega antes de `heartbeat_at` existir conta a partir de
`started_at`.

O que acontece com o job abandonado:

- **`render`**: nunca volta para a fila. Se o objeto já está em
  `output.storageKey` (o upload é tudo ou nada), o render foi entregue: vira
  `done` com `output.recovered = true`, `renderSeconds = null` e o checksum
  lido do storage, e a API o arquiva no Drive como qualquer outro. Se não
  está, vira `failed` com `worker_lost` e a pessoa pede de novo pela tela.
- **`enrich_lead`**: uma tentativa só (as buscas são pagas); vira `failed`.
- **`ffprobe` e `transcribe`**: voltam para `pending` enquanto `attempts` for
  menor que `WORKER_MAX_ATTEMPTS` (padrão 3), com `error` dizendo a tentativa;
  no limite, `failed` com `worker_lost`.

Cada decisão é um `update` condicional que confere de novo o id, o número da
tentativa e o heartbeat, então duas réplicas não decidem o mesmo job e um
worker só lento, que bateu no meio, fica com o seu. Pelo mesmo motivo,
`completeJob` e `failJob` só gravam se o job ainda é daquela tentativa: um
worker que volta atrasado não sobrescreve quem veio depois.

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

## Legenda inteligente (`type: caption_layout`, parte 3b)

No diálogo "Legendar", um vídeo vem com a caixa "Legenda inteligente: fugir de
rostos e de textos do vídeo" marcada. Ela manda `smart: true` em
`POST /studio/transcriptions`; num áudio a API ignora (`layout: null`).

| Coluna   | Valor                                                                            |
| -------- | -------------------------------------------------------------------------------- |
| `type`   | `caption_layout`                                                                 |
| `input`  | `{ version: 1, storageKey, transcriptStorageKey, transcriptionId, destination }` |
| `output` | `{ zones, frames, width, height }`; a API acrescenta `filed`                     |
| `error`  | mensagem do worker (`caption layout exited with status <n>`, sem stderr)         |

1. A `GET` que arquiva o SRT comum não muda. A `GET` seguinte, com o
   transcribe `done` e arquivado, enfileira **um** `caption_layout`, sob
   `select … for update` na linha do transcribe (`output.layoutJobId`), então
   duas abas não criam dois.
2. O worker lê do JSON da transcrição só os tempos das cues e roda
   `scripts/caption_layout.py`: para cada cue, de 1 a 6 quadros (meio, pontas
   e um a cada 2 s), reduzidos a 640 px de largura; rostos com **YuNet** e
   caixas de texto escrito com o **detector PP-OCRv3** (a metade de detecção
   do PaddleOCR, sem ler palavras), os dois em ONNX rodando no OpenCV, na CPU.
   Mede quanto de três faixas (em cima 4–30 %, meio 37,5–62,5 %, embaixo
   70–96 % da altura) está coberto; rosto pesa 3, texto pesa 1, e a caixa do
   rosto é esticada até o pescoço. Imprime só esses três números por cue.
3. `chooseZones` (`src/jobs/caption-layout.ts`) escolhe a faixa mais livre
   (empate: embaixo, em cima, no meio; cobertura abaixo de 2 % conta como
   livre) e depois junta qualquer trecho que ficaria menos de
   `CAPTION_MIN_RUN_SECONDS` (2 s) num lugar ao vizinho que custa menos. O
   `output` guarda **só as zonas**: nenhuma caixa, medida ou quadro sai do job.
4. Na primeira `GET` com o layout `done`, a API separa as cues por zona
   (`segmentsByZone`) e arquiva um SRT por zona usada, ao lado do vídeo:
   `<nome>.legenda-embaixo.srt`, `.legenda-em-cima.srt`,
   `.legenda-no-meio.srt` (nova versão quando já existe). Audita
   `studio.captions_layout_saved` com ids, zonas e contagens, sem texto.
5. A tela mostra "Procurando rostos e textos no vídeo…" com "Não esperar: pôr
   embaixo"; pronto, "Adicionar legenda à linha do tempo" põe um clipe de
   legenda por arquivo, cada um na sua posição. Se o layout falhar, o SRT
   comum continua lá e vai embaixo.

Os modelos são baixados no build da imagem (`scripts/fetch_caption_models.py`,
SHA-256 fixado) para `CAPTION_MODELS_DIR`
(`/opt/wings-worker-models/captions`); nada é baixado em tempo de execução.
Custo: R$ 0 (CPU do worker). Conferido no build local da imagem: vídeo de 9 s
com três cues (placa em cima e rosto embaixo; rosto em cima; quadro vazio)
deu custos que levam a meio, embaixo, embaixo; 12 quadros em 3,4 s com 2
threads.

**`WORKER_JOB_TYPES`**: onde a variável está definida (staging tem
`ffprobe,transcribe,render`), `caption_layout` precisa entrar na lista, ou o
job fica na fila para sempre (a tela ainda deixa pôr a legenda embaixo).

**LGPD.** Detectar rosto é tratamento de dado biométrico, mesmo sem
identificar ninguém. O que foi feito para minimizar: a detecção roda no nosso
servidor, só dentro do processo; nenhum rosto, caixa ou quadro é gravado,
registrado em log ou enviado a terceiros; só a posição escolhida para cada
trecho fica guardada. **Jurídico precisa avaliar** antes de usar em vídeo de
cliente com pessoas que não sejam da equipe Wings.

## Parte 2

- Proxy de baixa resolução (`type: proxy`): 540p H.264, gravado como
  `drive/proxy/<id do arquivo>`, para o editor abrir vídeo de uma hora sem
  engasgar. O projeto continua citando o original.
- Render no servidor com o mesmo motor do navegador (Chromium sem tela
  rodando `packages/studio`), para cobrir o esquema inteiro sem reimplementar
  em FFmpeg.
