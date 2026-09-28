# Catálogo de ferramentas dos agentes — especificação

28/09/2026. **Especificação: nada aqui foi construído.** Sem código, sem
migração, sem conta criada em fornecedor. Preços e condições de terceiros
foram lidos nas páginas públicas em 28/09/2026; o que não deu para confirmar
está marcado **não verificado**.

Uma ferramenta é o que um agente usa quando um consultor pede uma ação no
chat ("gere 5 ângulos desta foto", "monte uma LP no estilo destas
referências", "anime este vídeo"). Este catálogo diz, para cada uma, quem
pede, qual agente usa, com qual provedor, onde roda, quanto custa, quem pode,
se passa por aprovação, onde o resultado fica e o que pode dar errado.

Fora do escopo: OmniRoute (roteamento por provedores gratuitos não
confiáveis), FLUX 3 Action (robótica), Kimi Work (app desktop).

## 1. O que já existe e vale para todas

Nenhuma ferramenta nova inventa um caminho próprio. Todas reaproveitam:

| Peça                     | Onde                                                                                                             | O que garante                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agentes sobre OpenRouter | `apps/api/src/modules/agent/llm.ts`; `AGENT_MODEL` = `anthropic/claude-sonnet-5` ou `anthropic/claude-haiku-4.5` | teto por pessoa (`AGENT_DAILY_USD`, US$ 2/dia) e custo gravado por mensagem                                                                                                      |
| "Lê e propõe"            | cartões em `agent_proposals`; `docs/ads/agente-conversa.md`                                                      | o agente **nunca executa**: propõe um cartão, a pessoa clica                                                                                                                     |
| `scrub.ts`               | `apps/api/src/modules/agent/scrub.ts`                                                                            | CPF, telefone, e-mail e tokens viram marcadores antes de chegar ao modelo                                                                                                        |
| Contrato `MediaProvider` | `apps/api/src/modules/media/providers`; `docs/integracoes/provedores-de-midia.md`                                | estimativa primeiro, preço no botão (mesmo R$ 0), ledger antes da chamada, uma chamada, nunca repetir, teto `MEDIA_MONTHLY_BRL` (padrão R$ 300), failover só para baixo no preço |
| Jobs do worker           | `packages/shared/src/jobs.ts`; `apps/worker`                                                                     | fila com `FOR UPDATE SKIP LOCKED`, heartbeat, limites de CPU/memória (`WORKER_MEMORY_LIMIT_MB` 2048)                                                                             |
| Drive/R2                 | `docs/drive.md`                                                                                                  | resultado salvo por id na pasta **Mídia** do cliente (`Clientes/<NN>/08 Marketing/Mídia`) ou da Wings; link assinado de minutos; acesso por departamento                         |
| Portão de aprovação      | `apps/api/src/modules/ads/approvals.ts`                                                                          | só para **dinheiro de anúncio**. Mídia não passa por ele: passa pelo clique no preço                                                                                             |
| Studio                   | `packages/studio` (fork Shotstack, PolyForm Shield)                                                              | linha do tempo editável; render no navegador ou no job `render` (FFmpeg)                                                                                                         |

Regras que valem para todas as ferramentas novas:

1. **Custo antes, clique depois.** Toda ferramenta que gasta (API externa ou
   minutos de servidor) mostra o preço estimado no botão. Nenhuma roda por
   iniciativa do agente.
2. **Nome de cliente nunca vai a fornecedor.** Vale para prompt, nome de
   arquivo e metadado (regra do Kairogen estendida a todos).
3. **Arquivos vão por link assinado de 15 minutos**, nunca por URL pública.
4. **Resposta de fornecedor é registrada como forma** (`shapeOf`), nunca como
   texto.
5. **Ferramenta nova em servidor = job novo no worker**, com limite de tempo
   e memória e uma tentativa quando o trabalho é caro.
6. **O Agente de Tráfego não ganha nenhuma destas ferramentas.** A regra do
   CLAUDE.md (lê e propõe; não navega, não executa) continua como está.

### O servidor

Medido em 28/09: **8 vCPU (AMD EPYC), 31 GB de RAM, 354 GB livres, sem GPU.**
O worker está limitado a 2–3 GB. Tudo que exige GPU (Hunyuan3D, Nemotron
Diarization via NeMo, geração de vídeo local) **não roda aqui**; ou vai para
API externa, ou para uma GPU alugada por hora, que este documento não
recomenda na Fase 1.

## 2. Resumo

| #   | Ferramenta                                       | Agente            | Onde roda                                 | Custo por uso                                   | Permissão                                      | Aprovação                                | Decisão                                 |
| --- | ------------------------------------------------ | ----------------- | ----------------------------------------- | ----------------------------------------------- | ---------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| 1   | Legendas e animações sincronizadas à fala        | Edição            | servidor (worker)                         | R$ 0 (FFmpeg) ou licença Remotion ≥ US$ 100/mês | `marketing.media.edit`                         | não                                      | caminho FFmpeg ou Remotion              |
| 2   | LP/site a partir de referências                  | Design (novo)     | OpenRouter + servidor                     | ~US$ 0,30–1,50 por página (LLM)                 | `marketing.site.build` (nova) + `site.publish` | publicar exige pessoa com `site.publish` | domínio e hospedagem                    |
| 3   | Variações de ângulo da mesma foto                | Edição            | API externa                               | US$ 0,039/imagem (Gemini)                       | `marketing.media.generate`                     | clique no preço                          | ligar `GEMINI_BILLING_ENABLED`          |
| 4   | 3D: maquete (Blender) e produto (foto→3D)        | Design (novo)     | Blender no servidor; foto→3D na API Tripo | Blender R$ 0; Tripo US$ 0,20–0,30/modelo        | `marketing.3d.generate` (nova)                 | clique no preço                          | conta Tripo                             |
| 5   | Ligação de voz para lead (Fonio.ai)              | —                 | —                                         | €0,08–0,10/min                                  | —                                              | —                                        | **só avaliação: não recomendado agora** |
| 6   | Agente com navegador próprio (Hermes Bot Screen) | piloto            | **outro servidor**                        | tempo de máquina                                | `agents.browser.pilot` (nova)                  | cada sessão aberta por pessoa            | host separado                           |
| 7   | Diarização (quem falou quando)                   | Edição / Atas     | servidor (pyannote em CPU)                | R$ 0 (servidor)                                 | `marketing.media.edit`                         | não                                      | modelo e consentimento de gravação      |
| 8   | Vídeo Higgsfield para criativos                  | Edição            | API externa                               | US$ 0,20–3,23 por clipe                         | `marketing.media.generate`                     | clique no preço                          | atualizar o adaptador                   |
| 9   | Método "conteúdo compartilhável"                 | Copywriter (novo) | OpenRouter                                | centavos por peça (LLM)                         | `marketing.copy.write` (nova)                  | não (texto)                              | —                                       |

## 3. As ferramentas

### 3.1 Legendas e animações sincronizadas à fala

- **O consultor pede:** "anime este vídeo", "legenda palavra por palavra no
  estilo TikTok", "destaque os números que ele fala", "tire 3 cortes do
  podcast com legenda".
- **Agente:** Edição (`scope media`), com uma ferramenta de proposta nova,
  `propor_animacao`, que devolve uma lista de operações sobre a linha do tempo
  (como `propor_edicao` já faz).
- **Como funciona hoje:** o job `transcribe` usa faster-whisper "small" em
  CPU e grava SRT no Drive. O `render` é só FFmpeg.
- **Proposta em duas etapas:**
  1. **FFmpeg + ASS (recomendado primeiro).** A transcrição passa a pedir
     tempo **por palavra** ao faster-whisper (`word_timestamps`), e o render
     gera legendas ASS com karaokê (palavra ativa destacada), entradas e
     ênfases em palavras marcadas. Sem licença, sem Chromium, cabe no worker
     atual.
  2. **Remotion (se a Diretoria quiser motion graphics de verdade):**
     animações em React, com `@remotion/captions` para legendas por palavra.
     Render em Chromium sem GPU, no próprio servidor. **Licença:** grátis só
     para empresas com até 3 funcionários; a Wings precisa da Company
     License, modalidade "Automators": **US$ 0,01 por render, mínimo US$
     100/mês**. O worker precisaria de mais memória (Chromium: 2–4 GB por
     render).
- **Cortes de podcast:** o agente sugere trechos lendo a transcrição (com a
  diarização do §3.7 para saber quem fala) e propõe os cortes como operações
  `split`/`remove`; a pessoa confere e clica.
- **Custo:** FFmpeg R$ 0 (minutos de servidor). Remotion: a licença mensal.
  O cartão mostra a estimativa de tempo de render.
- **Permissão:** `marketing.media.edit`. **Aprovação:** não (não gasta
  dinheiro por uso).
- **Resultado:** MP4 na pasta Mídia do cliente, ligado ao projeto do Studio.
- **Risco:** precisão por palavra em PT-BR **não verificada** (whisper
  "small" erra nomes próprios; o texto é editável antes do render). Remotion:
  licença recorrente e dependência de um formato de projeto diferente do
  Studio.
- **Estimativa:** etapa 1, 4 dias; etapa 2, +6 dias.

### 3.2 LP/site "sem cara de IA" a partir de referências

- **O consultor pede:** "monte uma LP para a franquia X no estilo destas 6
  referências".
- **Agente:** Design gráfico (hoje só um item "em breve" no menu), novo
  `scope design`.
- **Fluxo:**
  1. **Referências:** upload de imagens/prints para o Drive (pasta do
     cliente). **Pinterest:** a API v5 lê pins de uma pasta, mas só de pastas
     da conta autenticada (e o app precisa de aprovação); ler pastas de
     terceiros **não é permitido** e raspar a página é proibido pelos termos.
     Proposta: a Wings mantém pastas próprias no Pinterest e conecta a conta,
     ou o consultor salva os prints.
  2. **Design system extraído:** o modelo com visão (Sonnet 5 via
     OpenRouter) lê as referências e devolve **tokens** (paleta, tipografia,
     escala de espaçamento, raios, sombras, tom das imagens, densidade) em
     JSON validado. A pessoa ajusta na tela e salva — fica como
     `design_system` do cliente.
  3. **Página:** o agente monta a página **a partir de uma biblioteca fechada
     de seções** (hero, prova social, números, etapas, FAQ, formulário), cada
     uma parametrizada pelos tokens; ele escolhe seções e escreve o texto
     (com o Copywriter, §3.9), não escreve HTML livre.
  4. **Prévia** em rascunho; **publicar** exige `site.publish` e um clique.
- **"Sem cara de IA" como regra verificável** (checagem automática antes da
  prévia): nada de gradiente roxo-azul genérico, nada de ícones de linha
  genéricos em grade de 3, fotos reais do cliente em vez de imagem gerada
  quando existirem, tipografia do design system (nunca a padrão do
  framework), texto sem os clichês listados na regra de copy.
- **Onde roda:** LLM na OpenRouter; montagem e prévia no servidor.
- **Custo:** ~US$ 0,30–1,50 por página (visão + texto; estimado pela tabela
  de preço do agente, dentro do `AGENT_DAILY_USD`).
- **Permissão:** `marketing.site.build` (nova) para montar; `site.publish`
  para publicar. **Aprovação:** o clique de publicar.
- **Resultado:** design system e página no banco; imagens no Drive; a página
  publicada vai para onde a Diretoria decidir (subdomínio da Wings ou do
  cliente).
- **Risco:** referências com marca de terceiros (direito autoral — a
  ferramenta extrai estilo, não copia peças); formulário da LP precisa cair
  no Funil Sofia com UTM (ver CRM Fase 1); hospedagem e domínio ainda não
  existem no sistema.
- **Estimativa:** 10 dias (biblioteca de seções é a maior parte).

### 3.3 Variações de ângulo da mesma pessoa/produto

- **O consultor pede:** "gere 5 ângulos desta foto do produto", "a mesma
  pessoa de perfil e de três quartos".
- **Correção sobre o que existe:** os **movimentos de câmera** (em staging
  desde 24/09) são texto acrescentado ao prompt de **vídeo** ("Camera
  movement: orbit 360") — não geram ângulos de uma foto parada. Esta
  ferramenta é nova, mas usa provedores que já estão ligados.
- **Agente:** Edição, ferramenta `propor_angulos` (N ângulos de uma lista
  fechada: frente, 3/4 esquerda, 3/4 direita, perfil, de cima, contra-plongée,
  detalhe), que vira um cartão com preço por imagem.
- **Provedor/modelo:** o que aceita **imagem de referência** e edita:
  - **Gemini 2.5 Flash Image** (`gemini/gemini-2.5-flash-image`): edita a
    imagem enviada, 1:1/4:5/9:16/16:9, **US$ 0,039 por imagem**. Hoje
    desligado até `GEMINI_BILLING_ENABLED=true`.
  - Kairogen com referência: **não verificado** qual modelo mantém a
    identidade da pessoa.
  - Higgsfield Soul e Cloudflare FLUX **não** aceitam referência: ficam de
    fora.
- **Custo:** 5 ângulos ≈ US$ 0,20 (≈ R$ 1,10), dentro do `MEDIA_MONTHLY_BRL`.
- **Permissão:** `marketing.media.generate`. **Aprovação:** o clique no preço.
- **Resultado:** uma imagem por ângulo na pasta Mídia, ligadas à original.
- **Risco:** **pessoa real** — gerar outra pose de alguém exige autorização de
  uso de imagem daquela pessoa (Jurídico); a consistência do rosto varia; o
  cartão avisa "confira antes de usar em anúncio".
- **Estimativa:** 2 dias.

### 3.4 Modelagem 3D

Dois usos, duas ferramentas:

**a) Maquete de loja/quiosque de franquia — Blender sem tela no servidor.**

- **O consultor pede:** "maquete do quiosque 3×2 m com as cores da marca e o
  logo no painel", "vista de cima da loja de 40 m²".
- **Como:** `blender -b` num job novo `blender_render`. O agente **não
  escreve Python**: escolhe um **modelo paramétrico** de uma biblioteca
  (quiosque, loja de rua, loja de shopping, food truck, balcão) e preenche os
  parâmetros (medidas, cores do design system, logo do Drive, material). O
  script do modelo é nosso, revisado e fixo.
- **Servidor aguenta?** **Sim, para imagens paradas**: Cycles em CPU
  funciona (minutos por imagem com poucas amostras). EEVEE precisa de GPU e
  não serve. Vídeo girando em volta da maquete: possível, mas de dezenas de
  minutos a horas — só em fila da madrugada.
- **Custo:** R$ 0 em dinheiro; o cartão mostra o tempo estimado.
- **Risco:** Python livre gerado por modelo rodando no servidor seria
  execução de código arbitrário — por isso só modelos paramétricos, em
  contêiner **sem rede**, com limite de CPU, memória e tempo.
- **Estimativa:** 5 dias com 3 modelos paramétricos.

**b) Produto 3D para anúncio — foto/texto → 3D.**

- **Hunyuan3D 2.1 (aberto, no servidor):** precisa de **10 GB de VRAM para a
  forma e 21–29 GB para textura**. O servidor não tem GPU → **não roda
  aqui**. A licença exclui UE, Reino Unido e Coreia do Sul (o Brasil está
  permitido) e exige licença da Tencent acima de 1 milhão de usuários
  mensais. As versões 2.5 e 3.x não têm pesos abertos.
- **Tripo (API, recomendado):** **US$ 0,01 por crédito**; texto→3D 10–20
  créditos (US$ 0,10–0,20), foto→3D 20–30 créditos (US$ 0,20–0,30), com
  textura. Entra como provedor novo no contrato `MediaProvider`, capacidade
  nova `generate_3d`.
- **Meshy (API):** créditos pré-pagos (foto→3D 5–35 créditos); preço do
  crédito na API **não verificado**. Alternativa se a Tripo decepcionar.
- **Resultado:** `.glb` na pasta Mídia; o Blender (item a) renderiza o
  produto em cena para virar imagem ou vídeo de anúncio.
- **Permissão:** `marketing.3d.generate` (nova). **Aprovação:** clique no
  preço.
- **Estimativa:** 3 dias (Tripo) sobre o item a.

### 3.5 Ligação de voz para lead (Fonio.ai) — só avaliação

| Ponto               | Fonio.ai                                                                                                                                                                                                           | SDR por WhatsApp (Sofia, parte 2)                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| PT-BR               | "português" listado; **PT-BR e números +55 não verificados**                                                                                                                                                       | nativo (texto)                                    |
| Preço               | €99/mês por 1.000 min (€0,10/min); €299 por 3.600 min (€0,08/min)                                                                                                                                                  | Z-API já contratado + LLM (centavos por conversa) |
| Onde ficam os dados | Viena; servidores Hetzner, Alemanha → **transferência internacional** (LGPD art. 33), exige DPA                                                                                                                    | Z-API (Brasil) + OpenRouter                       |
| Regra de telefonia  | Anatel: medida contra robocall prorrogada até 31/10/2028 (bloqueio de 15 dias e multa de até R$ 50 milhões, que alcança também quem contratou); "Não Me Perturbe"; 0303 dispensado para quem usa Origem Verificada | não se aplica                                     |
| Consentimento       | ligar para quem preencheu formulário: base legal a confirmar; gravação de voz é dado pessoal                                                                                                                       | o lead escreveu primeiro                          |
| Pronto no sistema   | nada                                                                                                                                                                                                               | captação pronta; conversa ainda não (parte 2)     |

**Recomendação:** **não agora.** Primeiro a Sofia por WhatsApp (o lead já
está lá, o custo é menor e o risco regulatório também). Reavaliar voz depois,
com: teste de PT-BR e número brasileiro em conta de demonstração, DPA
assinado, parecer do Jurídico, e só para leads com consentimento explícito
para ligação. **Estimativa:** 1 dia de teste de demonstração, quando decidido.

### 3.6 Agente com navegador próprio (Hermes Agent – Bot Screen) — piloto

- **O que é:** Hermes Agent (Nous Research) ganhou em 23/09/2026 o **Bot
  Screen**: cada robô tem uma área de trabalho Linux própria, transmitida ao
  vivo; a pessoa assume o controle para digitar login e 2FA e devolve ao
  robô. Cerca de 1,1–1,5 GB de RAM por tela aberta.
- **O que a própria documentação diz:** "as telas são superfícies de
  trabalho, **não barreiras de segurança**": os robôs compartilham usuário,
  arquivos e rede da máquina. O controle de quem mexe é "uma cerca da
  ferramenta, não do sistema". Conselho deles: não digite num robô um segredo
  que você não confiaria a ele; se isolamento importa, hosts separados.
- **Regras do piloto:**
  1. **Outro servidor**, pequeno e descartável. **Nunca** no servidor do
     Wings System (Coolify, bancos e as chaves de todos os apps estão aqui).
  2. **Só contas sem risco:** contas de teste, sem cartão, sem dado de
     cliente, sem acesso a Meta Ads, Google Ads, banco, Drive da Wings, RD ou
     e-mail corporativo.
  3. **Login e 2FA só pela pessoa**; a sessão fecha ao fim da tarefa; nenhuma
     senha salva no host.
  4. **Nenhum agente do Wings System chama o Hermes** no piloto; é uma
     ferramenta à parte, operada por uma pessoa.
  5. **O Agente de Tráfego nunca navega** (CLAUDE.md) — o piloto não muda
     isso.
  6. Gravação de tela das sessões, revisada ao fim do piloto.
- **Critério para sair do piloto:** um caso de uso concreto que nenhuma API
  resolve, e uma revisão de segurança do host.
- **Permissão:** `agents.browser.pilot` (nova), só Admin Master.
- **Estimativa:** 2 dias de preparação do host e do roteiro de teste.

### 3.7 Diarização (quem falou quando)

- **O consultor pede:** "separe as falas do convidado", "faça a ata dizendo
  quem disse o quê", "corte só as respostas do entrevistado".
- **Agente:** Edição (cortes de podcast); futuramente Atas (pasta Reuniões do
  Drive) e ligações.
- **Opções:**

|                     | NVIDIA Nemotron 3 Diarization                                    | pyannote community-1 (aberto)                              | pyannoteAI Precision (API)                            |
| ------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| Licença             | OpenMDW 1.1 (aberta)                                             | CC-BY-4.0, acesso com cadastro no Hugging Face             | pago                                                  |
| Vozes               | até 8, com streaming                                             | sem limite fixo                                            | sem limite fixo                                       |
| Hardware            | **GPU NVIDIA** (NeMo); porta ONNX existe, CPU **não verificado** | **roda em CPU**: ~1,7× o tempo do áudio (10 min → ~18 min) | na nuvem deles                                        |
| Qualidade publicada | DER 9,1% (CALLHOME-2), 12,7% (DIHARD III)                        | DER 20,3% (AliMeeting)                                     | 15,2% (AliMeeting)                                    |
| Português           | **não verificado**                                               | independe de idioma (voz)                                  | idem                                                  |
| Custo               | R$ 0 com GPU própria                                             | R$ 0 (minutos de servidor)                                 | ~€0,11 por hora de áudio (planos a partir de €19/mês) |
| Dados               | ficam aqui                                                       | ficam aqui                                                 | vão para fora (UE, **não verificado**)                |

- **Recomendação:** job novo `diarize` com **pyannote community-1 em CPU**,
  combinado à transcrição por palavra (§3.1): cada palavra ganha o falante. É
  lento, mas é tarefa de fila. Em paralelo, um teste de 1 dia com a porta ONNX
  do Nemotron em CPU; se funcionar em PT-BR e em tempo aceitável, troca. GPU
  não se justifica no volume atual.
- **Permissão:** `marketing.media.edit` (podcast); atas e ligações seguem a
  permissão do módulo onde o áudio está.
- **Resultado:** faixa de falantes junto ao SRT no Drive; na linha do tempo
  do Studio, cor por falante.
- **Risco:** **gravação de reunião e de ligação é dado pessoal** (voz):
  consentimento dos participantes antes de gravar; worker precisa de ~2–4 GB
  para o modelo.
- **Estimativa:** 3 dias (+1 de teste do Nemotron ONNX).

### 3.8 Vídeo Higgsfield para criativos

- **Há API?** **Sim.** Cobrança **por geração em dólar**, sem mensalidade e
  sem mínimo, separada dos planos do site (o "ilimitado" do site não vale na
  API). Modelos próprios (Soul, DoP, Marketing Studio) e de terceiros (Kling,
  Seedance, Veo, Wan, MiniMax…). Exemplos: Kling 3.0, 8 s em 720p ≈ US$
  0,45–1,00; faixa geral ≈ US$ 0,20–3,23 por clipe. Tabela oficial por modelo
  **não verificada** (a página é montada no navegador). Os resultados ficam
  lá **no mínimo 7 dias** e podem ser apagados depois — por isso o sistema
  copia para o Drive na hora.
- **O que já existe:** o adaptador `higgsfield.ts`, com Soul (imagem) e DoP
  (foto→vídeo, 5/10 s), preço configurado (`HIGGSFIELD_USD_PER_VIDEO_SECOND`
  0,10 → 5 s ≈ R$ 2,75), tudo **não verificado**.
- **⚠️ Divergência encontrada:** o adaptador chama
  `platform.higgsfield.ai/v1/...` com os cabeçalhos `hf-api-key`/`hf-secret`.
  A documentação pública atual indica `api.higgsfield.ai` com
  `Authorization: Key id:secret`. É provável que o adaptador precise ser
  atualizado antes da primeira geração real.
- **Proposta:** atualizar o adaptador pela documentação atual; ler o preço de
  cada modelo e gravá-lo na estimativa; oferecer Kling/Seedance/Veo pelo
  Higgsfield como modelos a mais no mesmo provedor (sempre com preço no
  botão; o mais caro nunca por failover).
- **Permissão:** `marketing.media.generate`. **Aprovação:** clique no preço;
  vídeo caro (acima de um valor que a Diretoria definir) pede segundo clique.
- **Risco:** DPA e local dos dados **não verificados**; preço que muda sem
  aviso (o ledger corrige com o custo informado na resposta).
- **Estimativa:** 2 dias.

### 3.9 Método "conteúdo compartilhável" (Copywriter)

- **O Copywriter ainda não existe** (item "em breve" no menu). Este item é a
  instrução de base dele.
- **Antes de criar**, o agente pergunta (ou lê do cadastro do cliente e do
  perfil de cliente ideal, e só pergunta o que falta):
  1. **nicho**; 2. **público**; 3. **emoção** que a peça deve provocar;
  2. **formato** (post, carrossel, reels, anúncio, e-mail, LP); 5.
     **objetivo** (alcance, lead, venda, marca).
- **Cada peça usa no mínimo 2 gatilhos de compartilhamento** (STEPPS, de
  Jonah Berger) e diz quais usou:
  - **Moeda social:** compartilhar faz quem compartilha parecer bem
    informado.
  - **Gatilho:** liga a mensagem a algo que o público vê sempre.
  - **Emoção de alta ativação:** espanto, entusiasmo, humor, indignação (não
    contentamento ou tristeza).
  - **Público/visível:** algo que se vê e se imita.
  - **Valor prático:** útil a ponto de ser repassado ("mande para quem…").
  - **História:** a marca é essencial à narrativa, não um carimbo no fim.
- **Saída:** cartão com a peça, os gatilhos marcados e a justificativa em uma
  linha cada. Passa pela checagem de conformidade que o Construtor já usa
  (`checkCopyCompliance`) antes de aparecer.
- **Ferramentas do Copywriter:** só leitura (cadastro do cliente, perfil de
  cliente ideal, desempenho de criativos). Não publica, não gera imagem —
  entrega texto para o Construtor, o Studio ou a LP (§3.2).
- **Permissão:** `marketing.copy.write` (nova). **Aprovação:** não.
- **Custo:** centavos de dólar por peça, dentro do `AGENT_DAILY_USD`.
- **Estimativa:** 3 dias (agente novo, `scope copy`, com testes de
  instrução).

## 4. Ordem de implementação (valor ÷ esforço)

| Ordem | Ferramenta                                     | Por quê                                           |   Dias |
| ----: | ---------------------------------------------- | ------------------------------------------------- | -----: |
|     1 | Copywriter com STEPPS (3.9)                    | serve a todo o resto (LP, criativo, post); barato |      3 |
|     2 | Higgsfield atualizado (3.8)                    | adaptador já existe; destrava vídeo de criativo   |      2 |
|     3 | Ângulos da mesma foto (3.3)                    | provedor já ligado; pedido frequente              |      2 |
|     4 | Legendas por palavra com FFmpeg (3.1, etapa 1) | Cortes de Podcast; sem licença                    |      4 |
|     5 | Diarização pyannote (3.7)                      | completa os cortes; abre atas                     |      3 |
|     6 | LP a partir de referências (3.2)               | alto valor, maior esforço                         |     10 |
|     7 | 3D: Blender paramétrico + Tripo (3.4)          | útil para expansão de franquia; nicho             |      8 |
|     8 | Remotion (3.1, etapa 2)                        | só se a etapa 1 não bastar                        |      6 |
|     — | Hermes piloto (3.6)                            | à parte, em outro servidor                        |      2 |
|     — | Fonio (3.5)                                    | só teste de demonstração, depois da Sofia         |      1 |
|       | **Total** (sem Remotion)                       |                                                   | **35** |

## 5. O que depende de decisão

1. **Remotion:** pagar a licença (≥ US$ 100/mês) ou ficar com FFmpeg.
2. **Gemini pago:** ligar `GEMINI_BILLING_ENABLED` (necessário para os
   ângulos).
3. **LP:** onde publicar (subdomínio Wings ou do cliente) e se a Wings cria
   pastas próprias no Pinterest para conectar.
4. **3D:** abrir conta na Tripo (API) e aceitar os termos.
5. **Higgsfield:** valor acima do qual um vídeo pede segundo clique.
6. **Hermes:** contratar um servidor pequeno separado para o piloto, e qual
   caso de uso testar.
7. **Fonio/voz:** confirmar que fica para depois da Sofia por WhatsApp.
8. **Jurídico:** uso de imagem de pessoa real em variações (3.3);
   consentimento para gravar reuniões e ligações (3.7); transferência
   internacional de dados (Fonio, pyannoteAI, Higgsfield).
9. **Teto de mídia:** se o `MEDIA_MONTHLY_BRL` (R$ 300) sobe com as
   ferramentas novas.
