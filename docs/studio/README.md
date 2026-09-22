# Wings Studio

Estúdio de edição de imagens e vídeos em Marketing → Edição de Fotos e
Vídeos. Desde a parte 2 é um espaço de trabalho só: a biblioteca, o gerador
com IA, a tela, as propriedades, o agente e a linha do tempo estão na mesma
página, no padrão dos editores de web (trilho de painéis à esquerda, tela no
centro, propriedades à direita, linha do tempo embaixo). As abas "Agente e
biblioteca" e "Studio" da parte 1 não existem mais; quem não tem
`marketing.media.edit` continua vendo o gerador e a biblioteca, com o agente
ao lado.

O núcleo é `packages/studio`, um fork do Shotstack Studio SDK 2.19.6. Por que
ele, e não o OpenCut, está em [`spike.md`](spike.md). O que mudou em relação
ao original está em `packages/studio/NOTICE.md`.

## A tela (parte 2)

| Onde               | O quê                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Barra de cima      | nome do projeto (clique para renomear), "Para quem" (o cliente: decide a pasta padrão, o logo em Elementos e o cliente da geração), formato 16:9 / 9:16 / 1:1 / 4:5, Imagem ou Vídeo, desfazer e refazer, Novo, Abrir do Drive, Salvar no Drive, Exportar, atalhos. Entre eles, a linha de créditos: saldo do Kairogen e o mês em reais contra o teto de todos os provedores.                |
| Trilho da esquerda | **Biblioteca** (mídia gerada ou enviada, com busca e filtros; e o Drive inteiro), **Gerar com IA** (o formulário da parte 1 condensado: modelo com custo por saída, prompt, referência, "Estimar" e depois "Gerar (custo)"; o resto em "Mais opções"), **Texto** (título, subtítulo, corpo), **Elementos** (logo da Wings, logo do cliente, formas), **Áudio** (música e narração do Drive). |
| Centro             | a tela do núcleo, com zoom, "Ajustar", guias de terços e a reprodução (no vídeo). Um arquivo arrastado de qualquer painel cai na tela; um clique em "Adicionar" faz o mesmo.                                                                                                                                                                                                                 |
| Direita            | Propriedades do item selecionado (posição, tamanho, opacidade, transição, fonte, cor, volume) e, dobrado embaixo, o Agente de Edição (aberto por padrão em telas largas, lembrado no navegador).                                                                                                                                                                                             |
| Embaixo            | a linha do tempo, quando a peça é vídeo, com o botão "Legendar"; o painel de camadas, quando a peça é imagem.                                                                                                                                                                                                                                                                                |

**Um projeto começa vazio.** O esquema do núcleo (fork) aceita `timeline.tracks`
sem nenhuma trilha (`EditSchema`, ver `packages/studio/NOTICE.md`), e o
documento inicial leva em `output.size` só largura e altura: o rótulo do
formato fica na tela. Uma recusa do núcleo nunca aparece como JSON: a pessoa
lê uma frase com o que fazer, e o detalhe vai para o console
(`friendlyCoreError`).

**Imagem na mesma tela.** Uma peça começa como imagem ou vídeo ("Novo"). Como
imagem, a tela tem camadas (imagem, texto, logo, forma) em vez de linha do
tempo; trocar o formato recorta a imagem de base para o novo tamanho
(`cropToAspect`); "Exportar" sai em PNG ou JPG no tamanho do formato, direto
para o Drive, por um quadro capturado do próprio núcleo (`captureFrame`). Pôr
um vídeo ou um áudio na tela muda a peça para vídeo; voltar para imagem só é
possível sem vídeo nem áudio, e o botão diz isso.

**Gerar variação e Editar com IA.** Com uma imagem da biblioteca selecionada
na tela, o painel Gerar com IA oferece os dois botões: eles preenchem a
referência (como referência de uma imagem nova, ou como a imagem a editar). O
custo continua vindo de "Estimar" antes de "Gerar"; nada é gerado por ter
clicado ali. Uma imagem que não está na biblioteca de mídia não serve de
referência: o provedor só recebe arquivos da biblioteca.

**Legendar.** O botão da linha do tempo manda o vídeo ou o áudio escolhido
para o job `transcribe` do worker (Whisper); o SRT é arquivado no Drive, na
pasta do arquivo, e um segundo clique põe a legenda na linha do tempo como
clipe `caption`, citando o SRT pelo id. O contrato está em
[`jobs.md`](jobs.md).

**Atalhos.** Espaço toca e pausa; Ctrl+Z e Ctrl+Shift+Z desfazem e refazem;
Delete remove o selecionado; S abre "Salvar no Drive"; as setas andam um
quadro. Nenhum atalho age enquanto o foco está num campo de texto. O botão
"?" da barra lista todos.

**Responsivo até 1280 px.** Abaixo de 1440 px o painel do trilho abre por
cima da tela e a coluna da direita encolhe para 280 px; todo botão tem foco
visível em laranja, e os ícones vêm sempre com o nome escrito. Estados vazios
dizem o que fazer: a tela vazia mostra "Comece por aqui" com as três
entradas (abrir do Drive, escolher da biblioteca, gerar com IA); uma
biblioteca vazia manda gerar ou enviar; um cliente sem logo manda enviar
pelo Drive.

**Onde cada coisa mora, na tela.** `components/studio/session.ts` é o
contrato entre o cérebro (`useStudioSession`, que tem o núcleo, o Drive e
toda ação que salva, exporta ou gasta) e a cara (`components/studio/workspace/`,
que só desenha estado e chama o contrato). Os painéis nunca tocam o núcleo:
a regra do projeto sem endereço tem uma porta só.

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
| A tela (sessão, painéis, propriedades, camadas)       | `apps/web/src/components/studio/`   |
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
- `apps/web/src/components/studio/workspace/StudioWorkspace.test.tsx`: cada
  botão termina numa chamada da sessão, o arrastar leva um MIME só, a doca
  troca entre linha do tempo e camadas pelo tipo da peça, Legendar e a
  exportação de imagem. A sessão (núcleo, regra do Drive) tem os próprios
  testes ao lado.

Nada foi executado num navegador de verdade neste ambiente. Os primeiros
testes de tela no staging estão no relatório da onda.

## Não verificado num navegador de verdade

Os testes de tela rodam contra uma sessão de mentira (o núcleo não abre no
jsdom). Só o staging confirma:

- arrastar da biblioteca e do Drive para a tela e para a linha do tempo do
  núcleo (o soltar na tela é nosso; o soltar na linha do tempo é do núcleo);
- `captureFrame` com WebGL, no tamanho do formato, para a exportação de imagem;
- o formato 4:5 no núcleo (1080 × 1350) na prévia e na exportação;
- CORS com `Range` no R2 para a prévia de vídeo (já era da parte 1);
- o painel do trilho por cima da tela abaixo de 1440 px e o layout a 1280 px;
- o primeiro "Legendar" real, de ponta a ponta (worker, SRT no Drive, clipe).

## Fica para depois

- Agente montando o primeiro corte a partir de um pedido (ferramenta que
  propõe um projeto; a pessoa abre e ajusta).
- Proxy de baixa resolução para vídeo de uma hora (job `proxy`).
- Textos da interface do núcleo em português (hoje em inglês, no código do
  SDK).
- Render no servidor com o mesmo motor do navegador (Chromium sem tela),
  para cobrir o esquema inteiro.
- Trazer correções do SDK original (ver `packages/studio/NOTICE.md`).
