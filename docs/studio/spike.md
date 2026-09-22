# Wings Studio — spike (22/09/2026)

Duas horas, protótipo descartável, para escolher o núcleo do editor de vídeo
manual de Marketing → Edição de Fotos e Vídeos (aba "Studio"). Candidatos:
**OpenCut** (MIT) e **Shotstack Studio SDK** (PolyForm Shield 1.0.0). O que
está aqui foi medido nos repositórios e pacotes em 22/09/2026; nada foi
executado num navegador, porque este ambiente não tem um.

## Veredito

**Shotstack Studio SDK, versão 2.19.6, trazido como fork em
`packages/studio`.** O OpenCut não serve como base hoje: a versão que funciona
foi arquivada em maio e a reescrita ainda não tem editor.

## O que foi olhado

### OpenCut

| Fato                    | Medido                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repositório principal   | `opencut-app/opencut`, 90,4 mil estrelas, 276 issues, 102 PRs. **Reescrita do zero em andamento** (núcleo em Rust, Moon, Bun). O app web tem 7 mil linhas de casca (TanStack Start) e nenhum editor    |
| Contribuições           | "We're not set up to take outside contributions yet while the architecture is being designed"                                                                                                          |
| Versão que funciona     | `opencut-app/opencut-classic`, **arquivada em 17/05/2026**, "no longer maintained". Next.js 15, 91 mil linhas de TypeScript, mais 4,3 mil linhas de Rust compiladas para `opencut-wasm` (npm, MIT)     |
| Acoplamento             | 34 arquivos importam `next`; `better-auth`, `drizzle`, `@upstash`, Cloudflare Workers. Tirar o editor do app é uma cirurgia de semanas, contra uma base que ninguém mais corrige                       |
| Funções                 | linha do tempo, transições, legendas (Whisper no navegador via `@huggingface/transformers`), desfazer, exportação por `mediabunny` (WebCodecs) e compositor em GPU. Cobre a lista, mas em código morto |
| Proxy para vídeo de 1 h | nenhuma menção                                                                                                                                                                                         |
| Licença                 | MIT                                                                                                                                                                                                    |

### Shotstack Studio SDK

| Fato                          | Medido                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pacote                        | `@shotstack/shotstack-studio` 2.19.6, publicado em 16/09/2026; 133 versões, várias por semana em setembro; fonte em `shotstack/shotstack-studio-sdk` (58 estrelas, 459 commits, 2 issues abertas, 3 contribuidores da empresa). Projeto de fornecedor, não comunidade                                     |
| Tamanho                       | 60 mil linhas de TypeScript (47 mil no núcleo, 12,7 mil na interface, 6 mil de CSS, 4 mil de modelos de demonstração); 85 arquivos de teste (Jest). Sem i18n: os textos da interface são em inglês no código                                                                                              |
| Bundle                        | protótipo em Vite: **3,4 MB minificado, 975 KB gzip**, um só chunk (Pixi.js 8, mediabunny, howler, opentype, zod). Só se carrega na aba Studio, por `import()`                                                                                                                                            |
| Faixas                        | vídeo, áudio, imagem (logo), texto (`rich-text`), legenda (`caption`, SRT/VTT ou palavras), HTML, forma, luma. Arrastar, redimensionar, mover entre faixas, encaixe, dividir, copiar e colar, teclado                                                                                                     |
| Transições                    | `transition.in`/`out` por clipe, no esquema e no painel                                                                                                                                                                                                                                                   |
| Formatos                      | `setOutputAspectRatio("16:9" \| "9:16" \| "1:1" …)`, `setOutputSize`, `setOutputFps`                                                                                                                                                                                                                      |
| Desfazer/refazer              | modelo de comandos, `edit.undo()`/`redo()`                                                                                                                                                                                                                                                                |
| Prévia                        | Pixi.js sobre WebGL/WebGPU; vídeo por `HTMLVideoElement` (streaming por URL, Range)                                                                                                                                                                                                                       |
| Exportação                    | `VideoExporter`: WebCodecs (`VideoEncoder`) + `mediabunny`, MP4 H.264 a **5 Mbps fixos**, AAC 192 kbps, fps escolhido, quadro a quadro a partir do canvas. Sem WebCodecs, lança erro (não há fallback)                                                                                                    |
| Serviço do fornecedor         | Nenhuma chamada à API deles no SDK. Dependências de rede que existem: fontes em `templates.shotstack.io` e `fonts.gstatic.com`, `hb.wasm` (HarfBuzz) em `js.shotstack.io`, `resvg` em `unpkg.com`. **Todas configuráveis** (`wasmBaseURL`, `wasmBinary`, lista de fontes) e passam a ser servidas por nós |
| `@shotstack/shotstack-canvas` | dependência compilada (sem fonte no npm), **MIT**; é o motor de texto rico e legendas                                                                                                                                                                                                                     |
| Proxy para vídeo de 1 h       | nenhuma menção. O clipe aponta para uma URL; um proxy é só outra URL, e a exportação no servidor usa o original                                                                                                                                                                                           |
| Licença                       | **PolyForm Shield 1.0.0**: uso, modificação e distribuição para qualquer fim, exceto "providing any product that competes with the software or any product the licensor provides using the software". Exige manter a linha `Required Notice: Copyright Shotstack Pty Ltd`                                 |

## Por que o Shotstack

1. É a única das duas bases que existe como editor pronto e mantido hoje.
2. Cobre a lista inteira sem escrever do zero: faixas, cortar, dividir, arrastar,
   transições, música, legendas, formatos, desfazer, prévia e exportação.
3. É uma biblioteca, não um aplicativo: entra numa aba da nossa tela sem trazer
   autenticação, banco ou framework próprio.
4. Nada nele depende de serviço do Shotstack; o que baixa da internet é
   configurável e passa a sair do nosso servidor.

## Riscos, em ordem

1. **Licença.** PolyForm Shield permite o uso interno da Wings e o fork. Não
   permite vender ou oferecer o Studio como produto que concorra com o
   Shotstack. Enquanto for ferramenta interna, está dentro; **antes de qualquer
   oferta a terceiros, o Jurídico precisa ler a licença.** A licença e a linha
   de aviso ficam em `packages/studio/LICENSE`.
2. **Fornecedor único.** Três pessoas de uma empresa mantêm o SDK. Se pararem,
   ficamos com 60 mil linhas nossas. O fork mantém um registro do commit de
   origem (`packages/studio/NOTICE.md`) para que se possa trazer correções
   deles depois.
3. **Bundle de 975 KB gzip.** Aceitável só porque carrega sob demanda, na aba.
4. **Exportação no navegador é lenta para vídeo longo.** Um quadro por vez, na
   thread principal, 5 Mbps fixos. Uma hora a 30 fps são 108 mil quadros. Por
   isso a exportação de vídeo longo, ou qualquer uma que falhe, vira um job de
   render no servidor (`docs/studio/jobs.md`). No fork, a taxa de bits passa a
   ser escolhida.
5. **Vídeo de 1 h na prévia.** O SDK toca por `HTMLVideoElement`, então uma
   hora de 1080p toca sem baixar tudo, mas com miniaturas e seek pesados. O
   proxy de baixa resolução (job no worker) fica para a parte 2.
6. **Links de 5 minutos.** O elemento de vídeo continua pedindo trechos (Range)
   pela mesma URL durante toda a edição. A URL do Drive dura 5 minutos; depois
   disso, um seek para trecho não carregado falha. O Studio pede um link
   próprio, de 60 minutos, e renova ao reabrir (ver `docs/studio/README.md`).
7. **CORS do bucket.** A prévia em WebGL exige `Access-Control-Allow-Origin`
   nas respostas do R2 para o vídeo, com `Range`. A configuração do bucket em
   `docs/drive.md` ganha `range` em `AllowedHeaders` e `Content-Range`,
   `Accept-Ranges` em `ExposeHeaders`. O volume local (`/api/drive/blob`) não
   responde a Range: em desenvolvimento a prévia toca, mas o seek é ruim.
8. **WebCodecs.** Exportar no navegador exige Chrome, Edge ou Safari recentes.
   Firefox sem WebCodecs cai direto no job do servidor.
9. **TypeScript e testes.** O SDK usa TS 5.6, Jest e ESLint Airbnb. No monorepo
   ele fica com `tsconfig` próprio e os testes migram para Vitest; o lint do
   repositório não passa sobre o código vendorizado, só sobre o que é nosso.

## O que o protótipo provou e o que não provou

Provou: o pacote instala e compila com Vite 7 e TypeScript 6 em Node 24
(`Edit`, `Canvas`, `Timeline`, `Controls`, `VideoExporter` importam e
constroem); o tamanho do bundle; que os endereços externos são configuráveis;
que o `shotstack-canvas` é MIT.

Não provou, porque não há navegador aqui: fluidez da linha do tempo com um
vídeo de uma hora, qualidade real da exportação, e o comportamento com a URL
vencida. Esses três são os primeiros testes de tela no staging.
