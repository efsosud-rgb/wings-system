# YouTube Data API v3 — canal da Wings

Leitura diária dos **dados públicos** do canal da Wings no YouTube: os vídeos
públicos e os contadores que qualquer pessoa vê (visualizações, curtidas,
comentários). Alimenta o bloco **YouTube** de Dashboard → Marketing → Canais
próprios e a lista **Vídeos do canal** do construtor de campanhas.

- **Só leitura.** A chave é de API (não OAuth): lê o que é público e nada
  mais; não há método de escrita no cliente (`apps/api/src/lib/youtube-data.ts`).
- **A chave nunca sai do servidor.** Vai na query string, como o Google
  documenta, e por isso nenhum endereço montado pelo cliente entra em erro,
  log, linha de `ingest_runs` ou resposta: falhas viram códigos
  (`quota_exceeded`, `key_invalid`…). A tela só sabe se há chave (`configured.key`).
- **A tela não chama o YouTube.** Lê as tabelas que a ingestão grava.
- **Nada estimado.** Crescimento é diferença entre duas leituras de dias exatos;
  "Short" vem de uma resposta clara do YouTube, nunca de palpite.

## Variáveis (API, staging e produção)

| Variável              | O que é                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `YOUTUBE_API_KEY`     | Chave do Google Cloud com a YouTube Data API v3 ativada. Sem ela a ingestão não roda e a tela mostra "—" com o motivo. Também guardada em `/root/.segredos/youtube-api-key` (600). |
| `YOUTUBE_CHANNEL_ID`  | Só quando a ficha da Wings Company não tem link do YouTube: `UC…` ou `@nome`.                                                                                                      |
| `YOUTUBE_INGEST_CRON` | Horário da leitura (cron de 5 campos, São Paulo). Vazio = `0 7 * * *` (todo dia às 07:00).                                                                                         |

## Qual canal

1. O link **youtube** das redes sociais da ficha da **Wings Company**
   (Formatação → Clientes → Wings Company → redes sociais). Aceita
   `youtube.com/@nome` e `youtube.com/channel/UC…`. Um link que não aponta
   para um canal (vídeo, `/c/…`, `/user/…`) é **relatado** (`bad_link`), não
   trocado em silêncio pela variável.
2. Se a ficha não tem link do YouTube: `YOUTUBE_CHANNEL_ID`.

Em 09/10/2026 a ficha do staging estava **sem** link do YouTube; a da produção
não foi conferida.

## A leitura diária

`modules/youtube/ingest.ts`, chamada pelo relógio da própria API
(`modules/youtube/scheduler.ts`; nada no Coolify) ou à mão:

```bash
# dentro do contêiner da API
node dist/modules/youtube/youtube-cli.js
```

Chamadas por leitura (cada `list` custa **1 unidade** da quota diária de 10.000):

| Chamada                                                                         | Quantas                             |
| ------------------------------------------------------------------------------- | ----------------------------------- |
| `channels.list` (`part=snippet,contentDetails`, por id ou `forHandle`)          | 1                                   |
| `playlistItems.list` da lista de envios (`UU…`), 50 por página                  | 1 a cada 50 vídeos (até 20 páginas) |
| `videos.list` (`part=snippet,contentDetails,statistics,status`), 50 ids por vez | 1 a cada 50 vídeos                  |

Um canal com 80 vídeos gasta 1 + 2 + 2 = **5 unidades por dia**.

- Só entram vídeos com `status.privacyStatus = public`.
- **Nada é gravado até todas as chamadas responderem**; então tudo vai numa
  transação só. Uma leitura que falha no meio deixa o dia anterior inteiro.
- Uma segunda leitura no mesmo dia **substitui** os números do dia (upsert).
- Cada execução é uma linha em `ingest_runs` com `trigger`
  `scheduled_youtube` ou `manual_youtube` e a coluna `youtube`:
  `{ source, channelId, channelTitle, listed, videos, truncated, calls, units, shorts }`.
  Essas linhas são de outro tipo (`kind: 'youtube'`) e **não** entram no
  status da ingestão de anúncios do painel.
- Agenda: roda quando o último horário do cron é mais novo que a última
  leitura (qualquer resultado). Assim recupera um horário perdido com a API
  fora do ar, não repete depois de um restart e **não tenta de novo uma
  leitura que falhou antes do próximo horário** (a quota não vira laço).
  Nunca duas leituras em menos de 55 minutos; quando o horário fica preso
  por isso (ex.: alguém rodou à mão às 06:30), a API olha de novo a cada 10
  minutos até a leitura do dia sair. Uma trava no banco
  (`pg_try_advisory_xact_lock(7202603)`) evita duas réplicas ao mesmo tempo;
  o CLI usa a mesma trava. A trava fica na conexão de uma transação aberta
  durante a leitura, o que depende do padrão do Postgres
  (`idle_in_transaction_session_timeout` desligado). Prazo de 10 minutos por
  leitura.

### Short

A Data API **não diz** se um vídeo é Short. A regra:

1. Vídeo com mais de 3 minutos **não é** Short (limite do YouTube desde
   15/10/2024) — sem pergunta nenhuma.
2. Os outros: `GET https://www.youtube.com/shorts/<id>` sem seguir
   redirecionamento. Redireciona para `/watch` = **não é**; responde **200 com
   a página que se declara aquele Short** (`<link rel="canonical"
href="https://www.youtube.com/shorts/<id>">`) = **é**; qualquer outra
   resposta (página de consentimento ou de verificação, erro, 200 sem esse
   canonical) = **não sabido** (`null`, "—" na tela), perguntado de novo no
   dia seguinte. Não usa a chave nem a quota. Até 50 perguntas por leitura,
   8 s cada, e para no prazo da leitura.

## Tabelas (migração 0083)

- `youtube_videos` — dimensão: um vídeo (`video_id` do YouTube, canal, título,
  publicação, duração em segundos, miniatura, `is_short`, `first_seen_at`,
  `last_seen_at` = instante da leitura que o viu por último).
- `youtube_video_daily` — fato: um vídeo num dia de São Paulo (`views`,
  `likes`, `comments` como totais do YouTube naquele dia; `likes`/`comments`
  nulos quando o canal esconde). Único por (vídeo, dia).
- `ingest_runs.youtube` (jsonb) — o resultado da leitura.

A migração dá `SELECT` ao `wings_ro` nas duas tabelas novas, quando o papel existe.

## A tela

`GET /marketing/youtube/videos` (permissão `ads.read`) → `YoutubeChannelResponse`
(`packages/shared/src/marketing/youtube-channel.ts`).

- Vídeos da última leitura completa, **por visualizações**.
- **+7 dias / +30 dias** = visualizações da última leitura − visualizações da
  leitura de **exatamente** 7 / 30 dias antes. Sem essa leitura: "—" com o
  motivo — "histórico começa depois de DD/MM" ou "sem leitura em DD/MM". A
  única exceção é o vídeo publicado depois daquele dia: as visualizações dele
  naquele dia eram zero por definição, então o crescimento é o total.
- "—" com o motivo também para: sem chave (`no_key`), sem canal
  (`no_channel`), link ruim (`bad_link`), nunca rodou (`never_ran`), e o aviso
  quando a última leitura falhou (com os números da última que deu certo).

## Construtor (Demand Gen)

No construtor (Marketing → Agente de Tráfego Pago — Wings → YouTube), embaixo
das caixas de vídeo, a lista **Vídeos do canal**
(`YoutubeChannelVideoPicker`, ligada em `YoutubeAdFields`) mostra os vídeos
públicos da última leitura, do mais visto ao menos visto, com o botão **Usar
este vídeo**: ele põe o link do vídeo na primeira caixa vazia. Um vídeo já nas
caixas aparece como "Escolhido"; sem caixa livre, os botões ficam desligados.
Sem chave, sem canal ou sem leitura, a lista diz o motivo e pede o link colado.

O vídeo escolhido entra na mesma caixa que o link colado, então a conferência
do servidor (público/não listado pelo oEmbed) é a mesma.

## Não verificado ao vivo

Escrito e testado contra um YouTube simulado (`modules/youtube/fake-youtube-api.ts`);
nenhuma chamada real foi feita. Conferir na primeira leitura real:

- formato das respostas de `channels`, `playlistItems` e `videos` (campos lidos
  acima) e os `reason` de erro (`quotaExceeded`, `keyInvalid`, `accessNotConfigured`);
- `forHandle` com o `@` (a documentação aceita com e sem);
- o `GET` em `/shorts/<id>` a partir do servidor e o `rel="canonical"` da
  página (país do servidor pode mostrar página de consentimento — aí fica
  "não sabido");
- se a chave tem restrição de API/IP no Google Cloud que bloqueie o servidor.
