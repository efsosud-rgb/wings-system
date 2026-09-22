# MoneyPrinterTurbo — provedor de mídia (vídeo "sem câmera")

Um serviço **nosso**, em `MPT_BASE_URL`, rodando o MoneyPrinterTurbo (projeto
aberto): recebe um assunto, escreve um roteiro com um modelo de linguagem,
narra com TTS, monta com cenas de banco (Pexels) e legenda. Aqui é o modelo
`mpt/short-video`, "Vídeo curto sem câmera", tipo vídeo, formatos 9:16, 16:9 e
1:1, uma saída por geração, sem duração escolhida (o roteiro decide).

Cobrança `own_service`: **R$ 0 por saída** no ledger. O que o serviço gasta do
lado dele (chave de LLM, Pexels, TTS) é conta daquele servidor, não deste
módulo. Não há cota: a disponibilidade é o serviço responder ao `ping`
(lembrado por um minuto).

Adaptador: `apps/api/src/modules/media/providers/mpt.ts`.

## O que o Eric precisa criar

1. Uma instância do MoneyPrinterTurbo (Docker, no mesmo servidor ou noutro),
   com as chaves dele configuradas no `config.toml` (LLM, Pexels/Pixabay,
   TTS). Nenhuma dessas chaves entra no Wings System.
2. O endereço da API → `MPT_BASE_URL` (por exemplo `http://mpt:8080` na rede
   do Coolify, ou um `https://` interno). Se ficar exposto na rede, ponha um
   proxy que exija bearer e informe `MPT_API_KEY`; o MPT não tem autenticação
   própria.
3. Idioma e voz padrão são do `config.toml` do serviço; o pedido daqui não os
   escolhe (ver "Não verificado").

## Como o adaptador fala (não verificado)

```
GET  {MPT_BASE_URL}/ping                       → qualquer resposta que não seja 5xx = disponível
POST {MPT_BASE_URL}/api/v1/videos
{ "video_subject": "<prompt>", "video_aspect": "9:16", "video_count": 1,
  "video_source": "pexels", "video_concat_mode": "random", "video_clip_duration": 5, "subtitle_enabled": true }
→ { "status": 200, "data": { "task_id": "…" } }
GET  {MPT_BASE_URL}/api/v1/tasks/{task_id}
→ { "data": { "state": 4 | 1 | -1, "progress": 40, "videos": ["…/final-1.mp4"] } }
```

`state` 1 é concluído, −1 é falha, o resto é "rodando". O arquivo só é baixado
de um endereço **no próprio host do serviço** (ou caminho relativo a ele), até
150 MB; qualquer outro host é ignorado. Timeout de 30 s no envio.

## Não verificado

- [ ] Se o `POST /api/v1/videos` exige `video_script` ou `video_terms` além do
      `video_subject`, e se aceita `video_language` (para forçar pt-BR) e
      `voice_name` no pedido.
- [ ] O nome do campo do id (`task_id`) e os valores de `state`.
- [ ] Se `videos[]` vem como URL absoluta ou caminho.
- [ ] O `/ping`.
- [ ] O tempo médio de uma tarefa (o acompanhamento desiste em 20 min, como
      nos outros).

## Primeiro teste real

Tipo Vídeo, grupo "MoneyPrinterTurbo", formato 9:16, um assunto em português
("por que franquear um negócio de bairro"). Botão **Gerar (R$ 0,00)**. O
cartão deve passar por "Gerando no MoneyPrinterTurbo" e "Salvando na
biblioteca". Se ficar em "Gerando" sem fim, olhar `mpt.task` no log: o
`state` está vindo com outro nome ou valor.
