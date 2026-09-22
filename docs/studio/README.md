# Wings Studio (parte 1)

Editor de vídeo manual em Marketing → Edição de Fotos e Vídeos, aba
**Studio**. Linha do tempo com faixas de vídeo, áudio, imagem (logo), texto e
legenda; cortar, dividir, arrastar, transições, formatos 16:9, 9:16 e 1:1,
desfazer e refazer, prévia, exportação. Abre e salva no Drive.

O núcleo é `packages/studio`, um fork do Shotstack Studio SDK 2.19.6. Por que
ele, e não o OpenCut, está em [`spike.md`](spike.md). O que mudou em relação
ao original está em `packages/studio/NOTICE.md`.

## Licença, antes de tudo

O núcleo está sob **PolyForm Shield 1.0.0**: uso interno, modificação e fork
são permitidos; **oferecer o Studio a terceiros como produto que concorra com
o Shotstack não é**. Enquanto for ferramenta da Wings para a Wings, está
dentro. Antes de qualquer oferta a cliente ou venda, o Jurídico lê
`packages/studio/LICENSE`. A linha `Required Notice: Copyright Shotstack Pty
Ltd` fica no arquivo e não sai.

## Onde cada coisa mora

| O quê                                                 | Onde                                |
| ----------------------------------------------------- | ----------------------------------- |
| Núcleo do editor (canvas, linha do tempo, exportação) | `packages/studio` (`@wings/studio`) |
| A aba e a integração com o Drive                      | `apps/web/src/components/studio/`   |
| Contrato tela ↔ API                                   | `packages/shared/src/studio.ts`     |
| Rotas e regras                                        | `apps/api/src/modules/studio/`      |
| Contrato com o worker (render no servidor)            | [`jobs.md`](jobs.md)                |

## Permissão

`marketing.media.edit` ("Editar vídeos no Studio, exportar e salvar no
Drive"): Admin Master, Diretoria e Marketing. Quem não tem vê a aba com um
aviso. Por baixo dela, cada arquivo e pasta passa pelo mesmo `driveAccessOf`
do Drive: arquivo de outro departamento responde 404 no Studio também.

## Regras que o código não deixa pular

1. **O projeto nunca guarda endereço.** O arquivo salvo
   (`<nome>.wings-studio.json`) cita cada mídia como
   `wings-drive://<id do drive_files>`. Enquanto edita, a tela troca o id por
   um link pré-assinado; ao salvar ou mandar renderizar, troca de volta. Um
   projeto com `http` num clipe é recusado pela API (`invalid_project`), e há
   teste de tela conferindo que o JSON salvo não tem link nem assinatura.
2. **Links do Studio duram 60 minutos**, não 5 (`GET /studio/files/:id/link`,
   auditado como `studio.file_opened`). O elemento de vídeo continua pedindo
   trechos pela mesma URL durante toda a edição; com 5 minutos, um seek para
   trecho ainda não carregado falharia no meio do trabalho. Passada uma hora,
   reabrir o arquivo pelo botão resolve um link novo.
3. **Salvar é o envio do Drive**, em dois passos, direto para o storage
   (`sendFile`): projeto e vídeo exportado entram como arquivo novo ou como
   nova versão de um existente (nome repetido oferece isso). A pasta é
   escolhida na hora; o cliente é o da pasta.
4. **Render no servidor é um job**, nunca uma chamada longa. A API enfileira
   (`POST /studio/renders`), o worker produz, e a primeira consulta que vê o
   job pronto arquiva o resultado no Drive (`studio.render_saved`). O contrato
   inteiro está em [`jobs.md`](jobs.md). Enquanto o worker não estiver no ar,
   o job fica "Na fila".

## O que sai de onde

- Fontes: Google Fonts (`fonts.gstatic.com`), pelo seletor do núcleo. As
  onze fontes "embutidas" do SDK, que vinham de `templates.shotstack.io`,
  passaram a apontar para a mesma lista; as duas que não são do Google (Clear
  Sans, MovLette) caem em Roboto.
- HarfBuzz (`hb.wasm`, legendas) e resvg (SVG): servidos pelo próprio app
  (`apps/web/dist/assets`), nunca de `js.shotstack.io` ou `unpkg.com`.
- Nada no núcleo chama um serviço do Shotstack. O bundle do editor (4 MB, 1,1
  MB gzip) só é baixado ao abrir a aba.

## O bucket (R2) precisa de `Range`

A prévia toca vídeo por `HTMLVideoElement` dentro do WebGL, então a resposta
do R2 precisa de CORS para leitura com `Range`. A configuração de
`docs/drive.md` ganhou `range` em `AllowedHeaders` e `Content-Range`,
`Accept-Ranges` e `Content-Length` em `ExposeHeaders`. Sem isso a prévia fica
preta no staging. O volume local (desenvolvimento) não responde a `Range`: a
prévia toca, o seek é ruim.

## Exportar

| Onde      | Quando                                                                        | Como                                                                                                  |
| --------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Navegador | padrão até 10 minutos de linha do tempo, com WebCodecs (Chrome, Edge, Safari) | quadro a quadro no canvas, H.264 5 Mbps + AAC 192 kbps (`VideoExporter.render`), sobe pelo `sendFile` |
| Servidor  | linha do tempo longa, navegador sem WebCodecs, ou falha no navegador          | job `render` (FFmpeg no worker, 8 Mbps por padrão), arquivado no Drive pela API                       |

## Testes

- `packages/studio`: os 85 arquivos de teste do SDK, rodando em Vitest (2 084
  testes). Nenhum toca a rede.
- `apps/api/src/modules/studio/studio.test.ts`: link de uma hora, 403 sem a
  permissão, 404 fora do departamento, recusa de projeto com endereço, chaves
  resolvidas no servidor e ausentes da resposta, arquivamento único do
  render, nova versão, `output_missing`, invisibilidade para outro usuário.
- `apps/web/src/components/studio/StudioEditor.test.tsx`: abrir do Drive pelo
  link, projeto salvo sem endereço, exportação no navegador, render no
  servidor com `wings-drive://` e acompanhamento do job.

Nada foi executado num navegador de verdade neste ambiente. Os primeiros
testes de tela no staging estão no relatório da onda.

## Parte 2

- Agente montando o primeiro corte a partir de um pedido (ferramenta que
  propõe um projeto; a pessoa abre e ajusta).
- Legendas por Whisper (job `transcribe`, que já existe no worker → SRT no
  Drive → clipe `caption`).
- Proxy de baixa resolução para vídeo de uma hora (job `proxy`).
- Textos da interface do núcleo em português (hoje em inglês, no código do
  SDK).
- Render no servidor com o mesmo motor do navegador (Chromium sem tela),
  para cobrir o esquema inteiro.
- Trazer correções do SDK original (ver `packages/studio/NOTICE.md`).
