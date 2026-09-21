# Drive (Onda 5, parte 1)

Pastas e arquivos da empresa, por departamento e por cliente. É um módulo
geral: aparece no menu de primeiro nível para quem tem `drive.read`, e cada
pessoa vê a árvore do seu departamento.

Três regras valem para tudo aqui:

1. **Nenhum caminho de volume nem chave de storage sai do servidor.** Um arquivo
   é citado pelo id. Para abrir ou baixar, o servidor entrega um endereço
   pré-assinado que dura minutos.
2. **Toda operação é auditada**, pelo id. Nome de arquivo não entra na
   auditoria, porque pode trazer o nome de uma pessoa.
3. **Quem decide o acesso é a API**, pasta por pasta. A tela só mostra o que a
   API devolveu.

## Armazenamento

`apps/api/src/lib/storage/` tem uma interface (`ObjectStorage`) e dois backends.

| Backend                       | Quando                                 | Como o navegador envia e baixa                                                            |
| ----------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| S3 compatível (Cloudflare R2) | as quatro variáveis `R2_*` preenchidas | direto no R2, por URL pré-assinada                                                        |
| Volume local (`MEDIA_DIR`)    | desenvolvimento e testes               | por `/api/drive/blob?t=…`, um token assinado por HMAC que faz o papel da URL pré-assinada |

O backend S3 assina com AWS Signature V4 feito à mão (`s3.ts`), sem SDK. O
assinador é conferido nos testes contra o exemplo que a própria AWS publica.
Nenhum teste fala com um bucket de verdade: o R2 é representado por um `fetch`
de mentira.

### Envio em dois passos

1. `POST /drive/uploads` com pasta, nome, tipo e tamanho. O servidor confere a
   permissão, o limite e o nome, grava um `drive_uploads` e devolve uma URL de
   `PUT` que vale 15 minutos. O tipo e o **tamanho exato** fazem parte da
   assinatura, então a URL não serve para outro arquivo nem para um maior.
2. O navegador envia os bytes para essa URL, com barra de progresso. A API não
   recebe o arquivo.
3. `POST /drive/uploads/:id/complete`. O servidor faz um `HEAD` no storage e só
   cria o `drive_files` se o objeto existe e tem o tamanho prometido. Se não,
   apaga o que chegou e responde `upload_incomplete`.

Limite por arquivo: `DRIVE_MAX_FILE_BYTES`, 2 GB por padrão. É um `PUT` único (o
R2 aceita até 5 GB assim); envio em partes, com retomada, fica para depois.

Baixar e ver a prévia: `GET /drive/files/:id/link` devolve uma URL de 5 minutos.
A prévia cobre imagem, vídeo e PDF.

### Variáveis

| Variável                                   | Para quê                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `R2_ENDPOINT`                              | `https://<conta>.r2.cloudflarestorage.com`                                     |
| `R2_BUCKET`                                | nome do bucket                                                                 |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | token de API do R2 com leitura e escrita nesse bucket                          |
| `R2_REGION`                                | opcional; o R2 usa `auto`, que é o padrão                                      |
| `DRIVE_MAX_FILE_BYTES`                     | opcional; padrão 2147483648                                                    |
| `MEDIA_DIR`                                | volume local; usado quando o R2 não está configurado e como origem da migração |

### O que o bucket precisa (CORS)

O envio é um `PUT` do navegador para outro domínio, com `Content-Type`. Sem
CORS no bucket o navegador bloqueia antes de enviar.

```json
[
  {
    "AllowedOrigins": ["https://staging.wingssystem.online"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Em produção, a origem é `https://wingssystem.online`, num bucket separado do de
staging. O bucket fica privado, sem domínio público: tudo sai por URL assinada.

## Modelo de dados

- `drive_folders`: árvore (`parent_id`), `department`, `client_id` opcional,
  `origin` (`manual`, `template`, `client`, `client_child`),
  `template_node_id` e `path`. O `path` são os nomes desde a raiz, para a trilha
  e a busca. Não tem relação com onde os bytes ficam.
- `drive_files`: pasta, nome, tipo, tamanho, `storage_key`, `version`, dono,
  `client_id`, `tags`, `checksum` e `trashed_at`. O `checksum` é `md5:` do ETag
  quando o navegador enviou direto, e `sha256:` quando o servidor gravou.
- `drive_file_versions`: o que o arquivo era antes de ser substituído.
- `drive_uploads`: envios pedidos e ainda não confirmados.
- `drive_template_nodes`: o modelo de pastas.
- Auditoria no `audit_log` que já existe, com ações `drive.*`.

Substituir um arquivo guarda o anterior como versão e soma 1 em `version`. As
versões antigas podem ser baixadas na prévia.

A lixeira guarda por 30 dias. Depois disso, uma varredura (ao abrir a lixeira e
a cada 6 horas) apaga os objetos do storage e as linhas. Apagar de vez antes do
prazo exige `drive.manage`.

Pastas do modelo e de clientes são mantidas pelo sistema: não se renomeia, move
nem exclui pela tela. Pasta criada à mão pode ser renomeada, movida e excluída
quando está vazia (arquivo na lixeira conta como conteúdo, porque pode voltar).

## Modelo de pastas

Administração → Drive: modelo de pastas (`drive.manage`). O seed grava o modelo
uma vez; depois ele é de quem edita, e o seed não mexe mais.

```
Formatação
  Marketing   (Mídia, Clientes → <Cliente> → Mídia)
  Jurídico, Financeiro, Produção, Processos, Logística, TI, RH-DP, Projetos
              (cada um com Clientes → <Cliente>)
  Clientes → <Cliente> → Reuniões, Documentos, Contrato, Propostas, Mídia   (o Dossiê)
Comercial     (Propostas Comerciais, Clientes → <Cliente>)
RH-DP         (Documentos, Contratos, Clientes → <Cliente>)
```

Um nó do tipo "pasta de clientes" vira uma pasta `Clientes` com uma pasta por
cliente ativo, e o que estiver abaixo dele no modelo é criado dentro de cada
cliente. A Wings Company não ganha pasta de cliente.

`syncDriveFolders` aplica o modelo. Só cria e renomeia, nunca apaga, e pode
rodar quantas vezes for preciso. Ele roda:

- no seed, a cada subida da API;
- ao cadastrar, renomear ou reativar um cliente (na rota de clientes, e não por
  gatilho no banco, para a operação ficar na auditoria com quem a fez);
- no botão "Sincronizar pastas".

Renomear o cliente renomeia as pastas dele em todos os departamentos, e o
`path` do que houver dentro. Cliente desativado mantém as pastas e não ganha
novas. Tirar um nó do modelo deixa a pasta onde está, como pasta comum.

## Permissões

`drive.read`, `drive.write` e `drive.manage`. Admin Master e Diretoria têm as
três com escopo `all` e veem tudo. Não existe um perfil "CEO" no sistema: quem
ocupa esse papel usa Diretoria ou Admin Master.

Os demais perfis têm leitura e escrita com escopo `sector`, que aqui quer dizer
"os departamentos do perfil" (`DRIVE_ROLE_DEPARTMENTS`, em `packages/shared`):

| Perfil                                        | Vê                                         |
| --------------------------------------------- | ------------------------------------------ |
| Marketing                                     | Formatação/Marketing                       |
| Formatação — Jurídico                         | Formatação/Jurídico                        |
| Formatação — Financeiro e Contábil/Tributário | Formatação/Financeiro                      |
| Formatação — Processos e Projetos             | Formatação/Processos e Formatação/Projetos |
| Formatação — Logística                        | Formatação/Logística                       |
| Formatação — TI                               | Formatação/TI                              |
| RH / DP                                       | RH-DP e Formatação/RH-DP                   |
| Gerente Comercial e vendedores                | Comercial                                  |

Formatação/Produção e o Dossiê (Formatação/Clientes) não pertencem a nenhum
perfil de departamento: só Diretoria e Admin Master veem.

A pasta acima da sua (por exemplo "Formatação" para o Marketing) aparece na
árvore só para dar passagem. Ela vem marcada `accessible: false`, não lista
arquivos e responde 404 se alguém pedir por id. Pasta e arquivo de outro
departamento respondem 404 em tudo: listagem, busca, lixeira, link, mover para
dentro. Os testes cobrem cada perfil.

## Biblioteca de mídia dentro do Drive

A biblioteca de Marketing → Edição passa a ser uma visão das pastas `Mídia`:
Formatação/Marketing/Mídia para a Wings Company e
Formatação/Marketing/Clientes/<Cliente>/Mídia quando o "Para quem" é um
cliente. Escolhi a pasta do cliente dentro de Marketing, e não a `Mídia` do
Dossiê, porque o perfil de Marketing não enxerga o Dossiê.

- `media_assets.drive_file_id` aponta para o `drive_files`. Upload e geração do
  Kairogen gravam no storage do Drive.
- Trocar o cliente de uma mídia move o arquivo para a `Mídia` daquele cliente.
  Mandar o arquivo para a lixeira do Drive tira a mídia da biblioteca; restaurar
  traz de volta.
- `GET /media/assets/:id/file` redireciona para uma URL pré-assinada de 5
  minutos quando o arquivo está no R2, e continua servindo do volume quando
  não está.
- O link que o Kairogen recebe para ler uma imagem de referência passa a ser a
  URL pré-assinada do R2, por 15 minutos, e continua registrado em
  `media_public_links`.
- No construtor de campanhas, "Escolher da biblioteca" virou "Escolher do
  Drive". Ele lista as mídias dessas pastas; escolher um arquivo qualquer do
  Drive fica para depois, porque o construtor precisa das dimensões que só a
  mídia tem.

### Migração do volume

```bash
# local
pnpm --filter @wings/api drive:migrate-media
# no contêiner da API
node dist/scripts/migrate-media-to-drive.js
```

Para cada mídia sem arquivo no Drive, o script lê os bytes em `MEDIA_DIR`, grava
no storage com a chave `drive/media/<id da mídia>`, cria o `drive_files` na
pasta certa e liga a mídia a ele. Para as que já têm arquivo, confere se o
objeto está no storage em uso e copia do volume se não estiver. Isso cobre o
ambiente que começa no volume e depois recebe o R2.

Pode rodar várias vezes: objeto que já existe não é enviado de novo, e mídia já
ligada não é ligada duas vezes. Nada é apagado do volume. A saída traz
contagens e ids; mídia cujo arquivo não está no volume é listada pelo id e
ignorada.

## Parte 2

- Importar do Google Drive.
- Cotas por departamento e por cliente.
- Compartilhamento externo (link para quem não tem login).
- Envio em partes com retomada, para arquivos acima de 2 GB ou conexões ruins.
- Lixeira e mover para pastas inteiras (hoje só arquivos vão para a lixeira).
- Escolher qualquer imagem do Drive no construtor de campanhas.
- Apagar do volume os arquivos já migrados, depois de conferidos.
