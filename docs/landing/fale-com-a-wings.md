# Fale com a Wings (apps/landing)

A página "Fale com a Wings" é a landing page da própria Wings Company em `https://fale.wingscompany.com.br`: a
versão aprovada pelo Eric (landing v3, 15/10/2026), só com fundo branco, com a asa da logo em partículas 3D, o
formulário no topo e os botões de WhatsApp. Ela é um app estático à parte, `apps/landing`, servido por um nginx próprio,
e conversa com o Wings System só pelas duas rotas públicas do formulário do site.

Código: `apps/landing/fale-com-a-wings/index.html` (a página), `src/pages/fale-com-a-wings/` (estilo, cena 3D,
formulário e o resto do comportamento), `src/lib/` (o que as próximas páginas vão reaproveitar: configuração em tempo de
execução, cliente da API, regras do formulário, rastreio, Turnstile, GTM, WhatsApp, fontes), `src/generated/wing-points.ts`
(os pontos da asa), `public/og/fale-com-a-wings.png` (a imagem de compartilhamento). Imagem: `docker/landing.Dockerfile`;
nginx: `docker/landing-nginx.conf`.

O que mudou em relação à prévia aprovada, e nada além disso: saíram o seletor Branco/Preto e todo o fundo preto, o aviso
de prévia da tela de obrigado e os avisos flutuantes dos botões de WhatsApp; o espaço "verificação antirrobô" virou o
Turnstile de verdade; o envio vai para a API; o `robots` passou a vir do ambiente; o exemplo do campo Site ficou
`www.suaempresa.com.br`.

## Como o lead entra

1. Ao abrir, a página pede `GET <LANDING_API_BASE>/public/site-forms/fale-com-a-wings` e recebe a chave pública do
   Turnstile, o link de WhatsApp e o formulário aprovado da regra.
2. O botão "Enviar" só liga com tudo preenchido (nome, WhatsApp com DDD, e-mail, empresa, Instagram, "O que você
   procura?", o aceite da política) **e** com a verificação antirrobô feita; a linha "Para enviar, falta: …" diz o que
   ainda falta, `verificação antirrobô` incluída enquanto o Turnstile não deu o token. O Site é opcional. O Instagram
   aceita `@marca`, `marca` ou o endereço do perfil e guarda só o usuário (`instagramUsernameOf`, `@wings/shared/instagram`).
3. O envio é `POST` na mesma rota, em JSON: `name`, `phone` (só dígitos), `email`, `companyName`, `instagram`
   (usuário), `siteUrl` (com `https://`, ou ausente), `qualifierAnswer` (o código da opção: `formatacao`, `expansao`,
   `consultoria`, `nao-sei`), `consent: true`, `page` (o endereço sem `#`), `tracking`, `turnstileToken` e `website` (a
   armadilha antirrobô, mandada como está: quem decide é o servidor).
4. A regra `fale-com-a-wings` vem do seed da API: cliente Wings Company, funil Formatação, formulário do site ligado,
   com as perguntas e os códigos acima. "Ainda não sei" deixa o lead **sem funil**, e quem decide é a triagem do Jev
   ([../leads/triagem-jev.md](../leads/triagem-jev.md)), só com a triagem ligada; com ela desligada, o lead fica em
   Formatação. As outras opções seguem o funil da regra. A frase do aceite ao lado da caixa é a `consentText` da regra,
   palavra por palavra, e é a que o lead guarda (um teste da API confere a página contra o seed). O construtor de
   campanhas não lista nem altera esta página (409 `landing_page_spec`). O resto (dono pelo rodízio, avisos, Turnstile
   conferido no servidor, limite por IP) é o formulário do site de sempre
   ([../leads/formularios.md](../leads/formularios.md)).

| Resposta da API           | O que a página faz                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 200 `{ ok, whatsappUrl }` | esconde o formulário e mostra o obrigado aprovado; o botão do obrigado abre o `whatsappUrl` do POST (ou o do GET) |
| 400 `invalid_request`     | mostra a frase da API embaixo do botão (`aria-live`) e mantém tudo o que foi digitado                             |
| 403 `captcha_refused`     | refaz o Turnstile e pede para verificar de novo                                                                   |
| 429                       | "Muitas tentativas. Tente de novo em alguns minutos."                                                             |
| 503, 404 ou rede fora     | "Não foi possível enviar agora. Tente de novo em instantes."                                                      |

Enquanto envia, o botão diz "Enviando…" e não aceita outro clique. Depois de qualquer falha que não seja 400, o
Turnstile é refeito (o token é de uso único).

**Origem do lead.** As 19 chaves de endereço de `SITE_FORM_TRACKING_KEYS` (UTMs, `gclid`, `fbclid`, `gbraid`,
`wbraid`, ids de campanha, conjunto e anúncio) mais o `referrer`. A primeira visita com alguma chave fica guardada no
navegador (`localStorage`, `wings_ft`) e nunca é sobrescrita; o envio manda a primeira visita com as chaves da visita
atual por cima. `utm_id`, `msclkid` e `ttclid` não vão (a API recusa chaves desconhecidas). Cada valor tem até 500
caracteres. A lista é copiada em `src/lib/tracking.ts` para a página não levar o pacote compartilhado inteiro; um teste
confere que é igual à do `@wings/shared`.

**WhatsApp.** Os botões "Falar no WhatsApp" e "Chamar no WhatsApp" viram links de verdade (`target=_blank`,
`rel=noopener`) assim que o GET responde com o link rastreado "Site" da Wings Company. A página não tem número nenhum:
sem link, o clique leva ao formulário e põe o cursor no nome, e o botão do obrigado não aparece. O link do GET leva só o
código do link (ainda não há lead); o do POST leva também a referência do lead, no formato `<código> <ref>` (6
caracteres cada, gerada e guardada pela API em `leads.form_ref`), para a Sofia saber de qual formulário a conversa
veio. A página nunca gera uma referência: usa o link que a API devolve. O e2e confere os dois formatos e, contra a API
de teste, que a referência do link é a que o lead guardou.

## Endereços (hosts e slugs)

Uma imagem só serve staging e produção; o ambiente diz quais hosts ela atende.

| Endereço                                          | O que mostra                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `https://<host>/` com par em `LANDING_ROOT_SLUGS` | a página do slug do par (em produção: `fale.wingscompany.com.br` → `fale-com-a-wings`) |
| `https://<host>/` sem par                         | 302 para `https://wingscompany.com.br/`                                                |
| `https://<host>/<slug>` e `/<slug>/`              | `dist/<slug>/index.html`; slug que o build não tem → 404                               |
| host fora de `LANDING_HOSTS`                      | 404 em tudo                                                                            |
| `/healthz`, em qualquer host                      | 200 `ok` (verificação do Coolify)                                                      |

- **Produção:** `fale.wingscompany.com.br` (a raiz é o "Fale com a Wings") e `lpfranquias.wingscompany.com.br` (as
  páginas de clientes, uma por slug, `https://lpfranquias.wingscompany.com.br/<slug>`). Os registros A dos dois, para
  `2.24.198.232`, já foram criados pelo Eric na HostGator.
- **Staging (sugestão):** `fale-staging.wingssystem.online` e `lpfranquias-staging.wingssystem.online`. Cada um
  precisa de um registro A para o servidor, a não ser que exista um curinga `*.wingssystem.online` (não verificado).

### Uma página de cliente nova

1. No CRM, em Landing pages, a regra do cliente com o slug e o formulário do site ligado (o formulário aprovado, se
   houver, vem pelo construtor de campanhas).
2. No código: `apps/landing/<slug>/index.html` e `apps/landing/src/pages/<slug>/` (o visual do cliente); o build
   acha a pasta sozinho. O formulário, o rastreio, o Turnstile e o WhatsApp vêm de `src/lib/`.
3. Quando as páginas de clientes forem ao ar em `lpfranquias`, trocar `LANDING_PAGE_BASE_URL` nas APIs para
   `https://lpfranquias.wingscompany.com.br` (só as regras criadas depois mudam de endereço; as 106 que já existem
   guardam o que têm) e pôr `https://lpfranquias.wingscompany.com.br` em `LANDING_ORIGINS`.

## Variáveis (nomes)

Contêiner da landing (Coolify, aplicação nova):

| Variável             | O que é                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LANDING_HOSTS`      | os hosts atendidos, separados por vírgula ou espaço (produção: `fale.wingscompany.com.br,lpfranquias.wingscompany.com.br`)                       |
| `LANDING_ROOT_SLUGS` | pares `host=slug` para a raiz (produção: `fale.wingscompany.com.br=fale-com-a-wings`; staging: o host de staging `=fale-com-a-wings`)            |
| `LANDING_API_BASE`   | a API que o formulário chama, terminando em `/api` (produção `https://wingssystem.online/api`, staging `https://staging.wingssystem.online/api`) |
| `LANDING_INDEXABLE`  | só `true` deixa os buscadores indexarem; qualquer outro valor manda `noindex, nofollow` (meta e `X-Robots-Tag`). Staging fica sem                |
| `LANDING_GTM_ID`     | o contêiner do Google Tag Manager (`GTM-MXJLC5HH`); vazio não carrega tag nenhuma                                                                |

Sem `LANDING_HOSTS` a imagem responde 404 em tudo menos `/healthz`; sem `LANDING_API_BASE` o formulário não carrega
("Não foi possível carregar o formulário").

API (`api-staging` e `api-prod`, com `wings-env`):

| Variável                | O que é                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LANDING_ORIGINS`       | as origens exatas que podem chamar `/public/*` do navegador (`https://fale.wingscompany.com.br` e, depois, o `lpfranquias`; no staging, os hosts de staging) |
| `TURNSTILE_SITE_KEY`    | a chave pública do widget                                                                                                                                    |
| `TURNSTILE_SECRET_KEY`  | a chave secreta (segredo: nunca em doc, log ou conversa)                                                                                                     |
| `LANDING_PAGE_BASE_URL` | onde nascem as páginas novas; padrão `https://franquia.wingscompany.com.br`                                                                                  |
| `WINGS_WHATSAPP_NUMBER` | já existe: o número da Wings que todo link rastreado abre                                                                                                    |

## Turnstile (passo a passo para o Eric)

1. Painel da Cloudflare → **Turnstile** → **Add widget**.
2. Nome "Wings landing pages"; modo **Managed**; hostnames `fale.wingscompany.com.br` e
   `lpfranquias.wingscompany.com.br` (e `wingssystem.online`, se o formulário do sistema também for usar a mesma chave).
3. Copiar a **Site Key** e a **Secret Key** para a `api-prod` com `wings-env` (`TURNSTILE_SITE_KEY` e
   `TURNSTILE_SECRET_KEY`); a página recebe a chave pública pela API, nunca do código.
4. No **staging**, usar as chaves de teste públicas da Cloudflare que sempre passam: site key
   `1x00000000000000000000AA` e secret `1x0000000000000000000000000000000AA` (valores de teste divulgados pela
   própria Cloudflare, não são segredo).

## Coolify (passo a passo)

1. Aplicação nova a partir deste repositório (a chave de deploy de sempre), branch `develop` no staging e `main` na
   produção.
2. Build pack **Dockerfile**, arquivo `docker/landing.Dockerfile`, contexto na raiz do repositório.
3. Porta **80**. Nunca publicar 80/443 no host: quem atende é o proxy do Coolify.
4. Domínios: produção `https://fale.wingscompany.com.br,https://lpfranquias.wingscompany.com.br`; staging os dois hosts
   de staging.
5. Variáveis do contêiner (tabela acima).
6. Healthcheck: caminho `/healthz`, porta 80 (a imagem também traz um `HEALTHCHECK` com o mesmo caminho).
7. Nas APIs: `LANDING_ORIGINS` e as chaves do Turnstile; depois o deploy pelo `wings-deploy` (produção só com PRODUCAO
   digitado pelo Eric).

## Roteiro de teste no staging

1. Abrir `https://fale-staging.wingssystem.online/?utm_source=teste&utm_campaign=landing` com o DevTools aberto: sem
   erro no console; a asa aparece; a página tem `noindex` (meta e cabeçalho `X-Robots-Tag`).
2. Antes de preencher: o botão "Enviar" está cinza e a linha diz o que falta, com "verificação antirrobô" até o
   Turnstile terminar.
3. Preencher com dados de teste (um WhatsApp de teste da equipe), Instagram como endereço do perfil (vira só o usuário
   ao sair do campo), escolher "Transformar meu negócio em franquia", aceitar a política: a linha vira "Tudo certo. Pode
   enviar."
4. Enviar: aparece "Obrigado! A Wings vai falar com você." com o botão "Chamar no WhatsApp", que abre o WhatsApp da
   Wings com o código do link.
5. No CRM Vendas → Negociações: a negociação nova da Wings Company no funil Formatação, origem formulário do site, com
   Instagram, empresa, site, a resposta "O que você procura?" e as UTMs do passo 1; o dono recebe o aviso de lead novo.
6. Repetir com "Ainda não sei": a negociação nasce sem funil e a triagem do Jev decide (com a triagem ligada no
   staging; desligada, a negociação nasce em Formatação).
7. Abrir `https://lpfranquias-staging.wingssystem.online/`: vai para `wingscompany.com.br`; `/fale-com-a-wings` mostra a
   página; `/qualquer-coisa` dá 404.

## Eventos do dataLayer

| Evento           | Quando                                       | Campos                                                                       |
| ---------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| `whatsapp_click` | clique num botão de WhatsApp que abre o link | `origem`: a primeira visita guardada (com `ts`) ou as chaves da visita atual |
| `lead_submit`    | depois que a API respondeu 200               | `interesse` (o código da opção) e o mesmo `origem`                           |

O GTM entra com o trecho padrão, `dataLayer` criado antes, e só quando `LANDING_GTM_ID` tem um id válido. O trecho
`<noscript>` do GTM não entra (o id é decidido em tempo de execução).

## Cabeçalhos e cache

Todas as respostas: `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action
'self'` (sem restringir `script-src`, para não quebrar as tags do GTM), `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` com
acelerômetro e giroscópio só para a própria página (o movimento do celular) e câmera, microfone e localização
negados. Arquivos de `/assets/` (nome com hash) ficam em cache por um ano (`immutable`); o HTML e o resto, `no-cache`.

## Desempenho e primeiro quadro

- O script da página bloqueia a renderização (`blocking="render"`), então o primeiro quadro já é o final: palavras
  separadas, linha do formulário preenchida. As fontes Limelight e Nunito vêm dentro do CSS (data URI) e são
  registradas pelo script antes do primeiro quadro, sem troca de fonte depois. O Font Awesome (só os ícones das redes)
  é um arquivo à parte com `preload`; se não carregar, aparece o nome da rede (`.no-fa`).
- O three.js chega depois do primeiro quadro (`import()` dinâmico, ~160 kB comprimido); sem WebGL, a página mostra a
  logo parada (`.no-gl`). `window.__wings3d()` informa partículas, pixel ratio, chamadas de desenho e memória.
- Resolução da cena (pixel ratio, sempre limitado ao da tela): computador até 2; celular com toque até 2
  (`PHONE_MAX_PR` em `scene.ts`; era 1,5); celular "fraco" (4 núcleos ou menos, ou 3 GB ou menos) 1. Com movimento
  reduzido nada mudou: celular com toque continua em 1,5.
- No celular (largura até 640 px, tela mais alta que larga) a asa tem outro lugar e fica com ~57% do tamanho: cada
  seção da cena traz `data-n="x,y,escala,opacidade"` (x em unidades do mundo vezes a proporção largura/altura da
  tela, y em unidades do mundo), longe de títulos e rótulos; onde ainda cruza texto a opacidade cai para ~35%. Acima de
  640 px valem `data-l` e `data-p`, como antes.
- O espaço do Turnstile já tem a altura do widget desde o primeiro quadro (sem pulo de layout).

## Regerar os pontos da asa e a imagem OG

Os dois ficam no repositório, e o build não precisa de navegador.

- `pnpm --filter @wings/landing wing-points`: rasteriza `src/assets/logo-wings.svg` a 1200 px no Chromium headless,
  pega 6000 pixels do laranja (#E95228) com sorteio de semente fixa (mesmo arquivo a cada vez), centraliza e grava
  `src/generated/wing-points.ts`.
- `pnpm --filter @wings/landing og-image`: renderiza a asa 3D de verdade sobre branco (1200×630, WebGL SwiftShader) e
  grava `public/og/fale-com-a-wings.png`; recusa uma imagem em branco.

Os dois usam o `playwright-core` da raiz e o Chromium headless em `~/.cache/ms-playwright/` (`CHROME_PATH` troca o
caminho), sem rede.

## Testes

- `pnpm --filter @wings/landing dev`: a página em `http://localhost:5174/fale-com-a-wings/`, com `/api` indo para a
  API local (`:3000`), como no `apps/web`.
- `pnpm --filter @wings/landing test`: os módulos puros (rastreio, corpo do POST, linha do que falta, configuração em
  tempo de execução, pontos da asa), com o bloqueio de rede do repositório.
- `pnpm --filter @wings/landing build && pnpm --filter @wings/landing test:e2e`: abre o `dist/` no Chromium headless
  (1440×900 e 390×844) com um servidor que imita o nginx, GTM e Turnstile falsos, API simulada pelo contrato, e
  aborta qualquer pedido para fora da máquina. Confere console limpo, sem rolagem lateral, primeiro quadro sem pulo
  (CLS < 0,02) e sem nada que some depois, um h1 e seis seções, botão desligado no começo, envio e obrigado com o link
  da API, e as respostas de erro. `API_BASE=http://127.0.0.1:3000` usa uma API local de verdade (com `E2E_PORT` fixo
  em `LANDING_ORIGINS`). Não faz parte do `pnpm test`.
- `DATABASE_URL=<banco local de desenvolvimento> pnpm --filter @wings/landing test:e2e:api` (depois do `build`): a
  "API de teste". `e2e/api-server.ts` cria um banco descartável (`wings_test_…`, o mesmo ajudante dos testes da API),
  roda o seed com um número inventado da Wings (para existir o link "Site"), sobe a API em `127.0.0.1` com as chaves
  de teste públicas da Cloudflare e o siteverify respondido no próprio processo (o bloqueio de rede da API é carregado
  primeiro) e roda o `e2e/run.mjs` contra ela em 1440×900, 390×844 e um terceiro envio com "Ainda não sei". Nada no
  caminho até a API é interceptado, então o preflight de CORS do navegador chega à API de verdade (o Playwright
  responderia ao preflight sozinho se interceptasse). Depois confere no banco: um lead por envio, `source`
  `site_form`, `landing_page` `fale-com-a-wings`, funil `formatacao` para as três respostas ("nao-sei" também: a API
  de teste roda sem a triagem do Jev), Instagram só com o usuário (digitado como `@Marca.Teste` ou endereço do
  perfil), `form_answers` com o texto da opção, o evento com o código, a frase do aceite guardada igual à da página e
  à `consentText` do seed, e que cada GET, preflight e POST do navegador recebeu o CORS da origem da página. Apaga o banco ao terminar, também com Ctrl+C; nenhum outro banco é lido ou escrito.

## Licenças

- Ícones das redes: Font Awesome Free 6.5.2, ícones sob CC BY 4.0 e a fonte sob SIL OFL 1.1; o aviso fica no CSS
  publicado (`/*! … */`).
- Fontes: Limelight (Sorkin Type Co) e Nunito (The Nunito Project Authors), SIL OFL 1.1, via `@fontsource`; o aviso
  também fica no CSS publicado.

## Não verificado ao vivo

- Turnstile com as chaves reais (só o falso do teste e as chaves de teste da Cloudflare).
- As tags do GTM disparando com `whatsapp_click` e `lead_submit` no contêiner real.
- A prévia do link (imagem OG) no WhatsApp e no Facebook.
- O nginx no Coolify (só conferido num contêiner local, sem porta publicada): hosts, raiz, 302, 404, `/healthz`,
  cabeçalhos e cache.
- Os registros A dos hosts de staging.
