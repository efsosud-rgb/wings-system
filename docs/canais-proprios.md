# Canais próprios — site da Wings (WordPress)

Onda 3c, 19/09/2026. Site: `wingscompany.com.br` (tema Hello Elementor +
Elementor Pro, Rank Math). Usuário da integração: `wings-system`, papel
**Autor**. Credenciais só nas variáveis do Coolify (ver [deploy.md](deploy.md)).

## O que o studio pode fazer no site — e só isso

| Ação                                 | Chamada                                    |
| ------------------------------------ | ------------------------------------------ |
| Ler categorias e tags                | `GET /wp/v2/categories`, `GET /wp/v2/tags` |
| Pôr uma mídia **nova** na biblioteca | `POST /wp/v2/media`                        |
| Criar um post **novo** como rascunho | `POST /wp/v2/posts`, `status: 'draft'`     |

`status: 'draft'` é um literal em `apps/api/src/lib/wordpress.ts`, não um
parâmetro. Toda escrita é um POST numa coleção: nenhum método do cliente recebe
o id de algo que já existe no site, então nada existente pode ser editado,
trocado ou apagado. Não cria termos: um Autor não pode, e a tela só oferece os
que existem. Publicar é um clique de uma pessoa dentro do WordPress.

## Como um rascunho é montado

1. **Imagens esperam no nosso banco** (`site_media_uploads`): JPG, PNG ou WebP,
   até 5 MB, tipo e dimensões lidos dos bytes no servidor. Servem à prévia.
   Nada vai ao site enquanto o operador escreve.
2. Ao clicar em **Criar rascunho**, o servidor confere tudo antes de enviar
   qualquer coisa: categorias e tags existem no site (lista em cache de 1 h,
   botão "Atualizar lista", no máximo uma leitura a cada 15 s), imagens existem,
   a destacada tem pelo menos 1200 × 630.
3. **As mídias sobem primeiro, uma a uma** — destacada, depois as do texto, na
   ordem. Se uma falhar, **o post não é criado**: a resposta diz qual arquivo
   falhou e o formulário fica como está. O id que o WordPress devolve fica
   gravado na linha da imagem, então reenviar o mesmo formulário **reaproveita**
   o que já subiu em vez de duplicar na biblioteca do site.
4. Só então o post é criado, com `categories`, `tags`, `featured_media` e o
   HTML do texto.
5. Tudo fica em `site_posts`: categorias e tags (id e nome), id da mídia
   destacada, e a lista `media` com papel, ordem, legenda, id no WordPress e se
   está na galeria — também nas tentativas que falharam.

## Texto, imagens, galeria e vídeo

O texto aceita Markdown simples (`##`/`###`, negrito, itálico, listas, links) e
continua funcionando como texto puro. Um único conversor, em
`packages/shared/src/marketing/site-content.ts`, gera a prévia do studio e o
HTML do WordPress, para os dois não divergirem. Ele escapa tudo o que foi
digitado antes de criar qualquer tag, e links só podem ser `http(s)` ou
`mailto`: o operador não consegue enviar marcação.

Marcadores no texto dizem onde a mídia entra: `{{img:N}}`, `{{galeria}}`,
`{{video}}` (os botões "Inserir…" colocam na posição do cursor). Sem marcador,
vai para o fim: imagens soltas, depois a galeria, depois o vídeo. Imagem que só
está na galeria não se repete sozinha.

- **Imagem**: bloco `wp:image` com `<figure>` e `<figcaption>`.
- **Galeria**: bloco `wp:gallery` com os ids. Verificado no site: os posts
  passam pelo widget "Post Content" do Elementor e o CSS de blocos carrega, então
  ela sai em **grade**. O bloco nativo não tem carrossel; carrossel depende de
  plugin e ficou de fora.
- **Vídeo**: só link do YouTube ou Vimeo, numa linha própria, que o WordPress
  transforma em player (oEmbed) — 6 posts do site já usam isso. Upload de
  arquivo de vídeo não existe, de propósito.

## SEO (Rank Math): não implementado

`GET /wp/v2/posts/2477?context=edit`, autenticado, não traz nenhum
`rank_math_*` em `meta` (só chaves do Elementor). O site não expõe esses campos
à REST, então o formulário avisa que palavra-chave foco, título SEO e meta
descrição são preenchidos no WordPress. Para mudar isso alguém teria de
registrar os metadados com `show_in_rest` no site — mexer no site, fora do
escopo do studio.

## Verificações feitas no site real (19/09/2026)

- `GET /wp/v2/media?per_page=1` autenticado: 200, 139 itens.
- Upload de teste: 201, **mídia id 2478**, título "[TESTE] wings-system
  verificação de upload" — para apagar à mão.
- Nenhum post de teste foi criado. Os testes automatizados usam `fetch`
  roteirizado e nunca tocam o site.
