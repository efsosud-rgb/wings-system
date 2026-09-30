# Upload de vídeo para anúncios, em partes

Os vídeos de anúncio (até 4 GB, MP4 ou MOV) sobem em **partes de 8 MiB**, uma
requisição por parte, em ordem. Nada aqui toca a Meta: o vídeo fica no volume
da API (`CREATIVE_VIDEO_DIR`) e só é enviado à plataforma quando um pedido
aprovado é executado.

## Por que em partes

O envio em uma requisição só (`POST /ads/videos`, mantido por compatibilidade)
não sobrevive a arquivos grandes:

- o Traefik v3 fecha a leitura de uma requisição em 60 s (`readTimeout` da
  entrada, valor padrão na v3), o que derruba qualquer envio que demore mais que
  isso — um vídeo de algumas centenas de MB numa conexão comum;
- o Node fecha uma requisição depois de 5 minutos (`requestTimeout` padrão);
- o navegador não tem como mostrar o progresso de uma requisição `fetch`.

Com partes de 8 MiB cada requisição termina em segundos, um erro de rede custa
uma parte e não o arquivo inteiro, e a barra na tela avança a cada parte.

## Fluxo

Todas as rotas exigem a permissão `ads.request`. Uma sessão pertence a quem a
abriu: outro funcionário recebe **404**, nunca 403 (um id não confirma que o
envio de outra pessoa existe).

| Rota                                    | Corpo                                   | Resposta                                                                                                                                                                                         |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /ads/videos/uploads`              | `{ mimeType, byteSize }`                | `201 { upload }` com `partSize`, `parts`, `receivedBytes: 0`, `nextPart: 1`. `400` tipo/tamanho inválido, `413 video_too_large` acima de 4 GB, `503 video_storage_not_configured` sem volume     |
| `PUT /ads/videos/uploads/:id/parts/:n`  | bytes crus (`application/octet-stream`) | `200 { upload }`. `409 part_out_of_order` (com `expected`) se `n` não é a próxima; repetir uma parte já recebida responde 200 sem gravar; `400 part_size_mismatch` se o tamanho não é o esperado |
| `POST /ads/videos/uploads/:id/complete` | —                                       | `201 { video }` (o mesmo `VideoUpload` do envio único). `409 upload_incomplete` faltando partes; `400 invalid_video` se os bytes não são um vídeo (arquivo e sessão apagados)                    |
| `GET /ads/videos/uploads/:id`           | —                                       | `200 { upload }`, para retomar um envio                                                                                                                                                          |
| `DELETE /ads/videos/uploads/:id`        | —                                       | `204`, apaga o parcial e a sessão                                                                                                                                                                |

Regras das partes: toda parte menos a última tem exatamente `partSize` bytes;
a última tem `byteSize − (parts − 1) · partSize`. Uma parte de tamanho errado é
recusada inteira e nada é gravado, então o deslocamento da próxima continua
certo. Cada parte é gravada no deslocamento `(n − 1) · partSize` do arquivo
`<storage_key>.part`; por isso uma parte repetida nunca entra duas vezes.

Em `complete` o servidor confere o tamanho total, lê o arquivo uma vez
(hash SHA-256 e a caixa `ftyp` no byte 4 — o que o cabeçalho diz não é prova,
o que os bytes dizem é), renomeia para `<storage_key>` e grava a linha em
`ad_video_uploads` exatamente como o envio único. A partir daí o vídeo é
servido por `GET /ads/videos/:id`, com _byte ranges_.

O nome no disco é nosso (`<uuid>.mp4|mov`): nenhum nome vindo do cliente vira
caminho.

## Tabela `ad_video_upload_sessions` (migration 0047)

| Coluna           | O que é                                              |
| ---------------- | ---------------------------------------------------- |
| `id`             | id da sessão, o que o cliente usa nas rotas          |
| `mime_type`      | `video/mp4` ou `video/quicktime`                     |
| `byte_size`      | tamanho prometido do arquivo                         |
| `part_size`      | 8 MiB (`VIDEO_UPLOAD_PART_BYTES` em `@wings/shared`) |
| `received_bytes` | quanto já chegou                                     |
| `next_part`      | a próxima parte aceita                               |
| `storage_key`    | nome do arquivo no volume (o parcial é `<key>.part`) |
| `uploaded_by`    | quem abriu; só essa pessoa vê a sessão               |
| `expires_at`     | `created_at + 24 h`                                  |

Uma sessão que ninguém termina em um dia é apagada (linha e `.part`) na
próxima abertura de sessão, de qualquer pessoa.

No staging, a tabela fica legível pelo `wings-staging-sql` porque a migration
`0048` concede `SELECT` à role `wings_ro` quando ela existe (em produção, local
e nos bancos de teste ela não existe, e a migration não faz nada). Toda tabela
nova que o `wings_ro` deva ler entra assim, por migration, nunca por comando à
mão.

## Limites

- Arquivo: `MAX_VIDEO_BYTES` = 4 GB (o limite da Meta).
- Parte: `bodyLimit` da rota = 8 MiB; uma parte maior é recusada pelo Fastify
  antes do handler.
- Tipos: MP4 e MOV. A caixa `ftyp` é conferida no fim, não no início: uma
  sessão aberta com bytes que não são vídeo é desfeita no `complete`.
