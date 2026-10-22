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
2. O botão "Enviar" só liga com os três campos obrigatórios preenchidos (nome, WhatsApp com DDD e "O que você
   procura?"), o aceite da política **e** a verificação antirrobô feita; a linha "Para enviar, falta: …" diz o que ainda
   falta, `verificação antirrobô` incluída enquanto o Turnstile não deu o token. E-mail, nome da empresa, Instagram e
   site são **opcionais** desde a versão curta (22/10, abaixo): ficam dentro do bloco recolhido "Quer adiantar?
   (opcional)", um `<details>` nativo, e só são conferidos quando preenchidos (e-mail com `@` e domínio; site com
   domínio; o Instagram aceita `@marca`, `marca` ou o endereço do perfil e guarda só o usuário, `instagramUsernameOf`,
   `@wings/shared/instagram`). Um opcional preenchido errado segura o envio com a frase embaixo do campo, mas nunca
   aparece na linha "falta".
3. O envio é `POST` na mesma rota, em JSON: `name`, `phone` (só dígitos), `qualifierAnswer` (o código da opção:
   `formatacao`, `expansao`, `consultoria`, `nao-sei`), `consent: true`, `page` (o endereço sem `#`), `tracking`,
   `turnstileToken` e `website` (a armadilha antirrobô, mandada como está: quem decide é o servidor); `email`,
   `companyName`, `instagram` (usuário) e `siteUrl` (com `https://`) vão só quando preenchidos.
4. A regra `fale-com-a-wings` vem do seed da API: cliente Wings Company, funil Formatação, formulário do site ligado,
   com as perguntas e os códigos acima e `requiredFields: ['qualifierAnswer']` (a versão curta; a API recusa com 400 um
   envio sem a resposta). "Ainda não sei" deixa o lead **sem funil**, e quem decide é a triagem do Jev
   ([../leads/triagem-jev.md](../leads/triagem-jev.md)), só com a triagem ligada; com ela desligada, o lead fica em
   Formatação. As outras opções seguem o funil da regra. A frase do aceite ao lado da caixa é a `consentText` da regra,
   palavra por palavra, e é a que o lead guarda (um teste da API confere a página contra o seed). O construtor de
   campanhas não lista nem altera esta página (409 `landing_page_spec`). O resto (dono pelo rodízio, avisos, Turnstile
   conferido no servidor, limite por IP) é o formulário do site de sempre
   ([../leads/formularios.md](../leads/formularios.md)).

## Versão curta (22/10/2026, rascunho; depende do PR #14)

Nos 3 dias do anúncio (20 a 22/10) a página teve 71 visitas e nenhuma tentativa de envio; a hipótese é o atrito de um
formulário de 6 campos para um público frio e em boa parte 65+. A versão curta pede só **nome, WhatsApp e "O que
você procura?"** (a pergunta define funil e rodízio); e-mail, empresa, Instagram e site ficam opcionais num bloco
recolhido. Campos e botão maiores (campo 56 px / 18 px, rótulo 16 px, botão 60 px / 17 px, 15 px no embed, cuja coluna pode ter 280 px). No celular (390 px): o
formulário passou de 1026 px (7 campos à vista) para 835 px (3 campos e a linha "Quer adiantar?"), 1235 px com o bloco
aberto; o botão "Enviar" termina em 1062 px da página em vez de 1256 px.

**Onde mora a lista de obrigatórios.** Em dois lugares, e os dois precisam mudar juntos: no código da página
(`src/lib/form-rules.ts`, `form.html`) e no banco, em `lead_source_rules.site_form_spec.requiredFields` da regra
`fale-com-a-wings`, que a API confere no POST (`siteFormAnswersOf`). O seed só **insere** a regra; ele nunca altera a
de um ambiente que já a tem. Staging e produção guardam hoje `["email","companyName","instagram","qualifierAnswer"]`
(lido no staging em 22/10). Com a página curta no ar e a lista antiga no banco, **todo envio sem e-mail recebe 400
"Informe o seu e-mail."** e a página mostra isso embaixo do botão. Por isso a ordem é: primeiro o banco, depois a página.
O ajuste, que **ninguém aplica sem o OK do Eric** (`wings_ro` não escreve; é na base do Coolify ou numa migração
`drizzle-kit generate --custom`), só mexe na linha que ainda tem a lista do seed:

```sql
UPDATE lead_source_rules
   SET site_form_spec = jsonb_set(site_form_spec, '{requiredFields}', '["qualifierAnswer"]'::jsonb)
 WHERE kind = 'landing_page' AND pattern = 'fale-com-a-wings'
   AND site_form_spec->'requiredFields' = '["email","companyName","instagram","qualifierAnswer"]'::jsonb;
```

A página `/lp/fale-com-a-wings` do Wings System lê a mesma lista e deixa de pedir e-mail no mesmo momento; o embed
`/embed/formulario` usa o mesmo `form.html` e fica curto junto.

**O que muda e o que não muda.**

- **Dedupe:** `upsertLead` procura o lead pelo telefone e só depois pelo e-mail; sem e-mail, só pelo telefone. A regra
  "só preenche campo vazio" (`fillGaps`) não muda: um lead antigo guarda o e-mail, a empresa e o Instagram que já tinha.
  Quem está no CRM só com e-mail (veio do RD sem telefone) e envia a página curta vira um segundo lead.
- **Rodízio e funil:** iguais. O funil vem só da resposta (`answerPipelineOf`) e o rodízio só do funil
  (`nextInRotation`); nenhum dos dois lê e-mail, empresa ou Instagram. Vale a regra de hoje: nesta página, sem marca,
  "Expandir minha rede" fica em Formatação, e "Ainda não sei" vai à triagem do Jev só com ela ligada.
- **RD Station:** o lead chega ao CRM pelo POST da API, com ou sem e-mail. O script do RD que o GTM carrega manda o
  formulário a `form_integrations`, que identifica o contato pelo e-mail: sem e-mail, o RD não cria a conversão (nem
  ecoa o lead pelo webhook); com o e-mail preenchido no bloco opcional, tudo como hoje. A cópia da API ao RD já
  pulava sem e-mail (`rdForward: no_email`). O Lead da Meta e a conversão do Google Ads nesta página dependem do
  rascunho do GTM em `lead_submit` (workspace 20), não do RD.
- **Validações:** a página confere e-mail, Instagram e site só quando preenchidos; a API segue conferindo nome (2+),
  telefone com DDD, consentimento, Turnstile, honeypot e a resposta, e um e-mail mandado errado ainda dá 400
  "E-mail inválido".
- **Eventos (PR #14) e `lead_submit`:** iguais. Abrir o bloco opcional não é toque em campo, então não conta
  `form_start`; `form_view` dispara com 1/3 do formulário na tela, agora menor.
- **Checagem do Instagram e pesquisa:** só rodam quando há Instagram (`hasInstagramToCheck`); a pesquisa paga
  continua desligada para o formulário do site.

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

## Eventos para o servidor (contagem sem dado pessoal)

Além do dataLayer, a página manda cada passo do visitante à API com `navigator.sendBeacon`
(`POST /public/site-forms/:slug/events`, `apps/api/src/modules/leads/site-events.ts`): corpo pequeno em `text/plain`
(sem preflight), resposta 204, o mesmo CORS da rota do formulário e um limite por IP próprio (300 em 10 minutos). A API
grava **uma linha de log JSON por evento** (`"msg":"site event"`) e nada mais: sem tabela, sem migração, e a rota não
escreve a linha de requisição padrão do Fastify (`logLevel: 'warn'`), que levaria o IP ao lado do evento. O envio nunca
espera resposta nem trava o formulário: um beacon perdido é só um evento a menos. Um navegador sem `sendBeacon` não
conta nada.

| Evento           | Quando                                          | `step`                                             |
| ---------------- | ----------------------------------------------- | -------------------------------------------------- |
| `page_view`      | na carga                                        |                                                    |
| `form_view`      | um terço do formulário entrou na tela (uma vez) |                                                    |
| `form_start`     | primeiro campo tocado                           |                                                    |
| `submit_attempt` | cada clique em enviar                           |                                                    |
| `submit_error`   | envio recusado                                  | `validation`, `captcha`, `rate_limited`, `network` |
| `submit_ok`      | a API respondeu 200                             |                                                    |
| `whatsapp_click` | clique num botão de WhatsApp que abre o link    | `header`, `final`, `thanks`                        |

Cada linha leva `slug`, `event`, `step`, `visit` (id aleatório da aba, só em `sessionStorage`, sem cookie), `utm_source`,
`utm_medium`, `utm_campaign` e `utm_content` (da primeira visita guardada, senão da atual) e `device`/`os`/`app` lidos do
User-Agent **no servidor** (`phone`/`tablet`/`desktop`, `android`/`ios`/`other`, `instagram`/`facebook`/`browser`).
Nunca nome, e-mail, telefone, IP nem o User-Agent inteiro; uma UTM que pareça e-mail (`@`) ou telefone (8 dígitos
seguidos) entra como `null`. A lista fechada de eventos e passos é `siteEventSchema` (`packages/shared`);
`events.test.ts` da landing confere que a cópia da página é igual.

As contagens são **indicadores declarados pelo navegador** (a rota é pública, sem captcha): servem para ver onde o
visitante para, não para contar conversão. `submit_ok` se confere na tabela de leads (`source` `site_form`); um `visit`
distinto por evento ajuda a ignorar um robô que repete.

Contar (o log do contêiner da API some a cada deploy):

```bash
docker logs <contêiner da API> 2>&1 | grep '"msg":"site event"' \
  | jq -r '[.event, .step // "-", .app, .device] | @tsv' | sort | uniq -c | sort -rn
```

Por aba (o funil de uma visita): `... | jq -r '[.visit, .event, .step // "-"] | @tsv' | sort`.

## Cabeçalhos e cache

Todas as respostas, menos `/embed/formulario` (seção abaixo): `Content-Security-Policy: frame-ancestors 'none'; base-uri
'self'; object-src 'none'; form-action 'self'` (sem restringir `script-src`, para não quebrar as tags do GTM),
`X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` com
acelerômetro e giroscópio só para a própria página (o movimento do celular) e câmera, microfone e localização
negados. Arquivos de `/assets/` (nome com hash) ficam em cache por um ano (`immutable`); o HTML e o resto, `no-cache`.

## Formulário no site (iframe em `/embed/formulario`)

O formulário desta página aparece também na home do site (wingscompany.com.br) dentro de um iframe de
`https://fale.wingscompany.com.br/embed/formulario`: o mesmo HTML (`form.html`, incluído pelas duas páginas), as mesmas
regras, Turnstile (tema escuro), envio e tela de agradecimento; fundo transparente e letras brancas (aberto fora de
iframe, o fundo é preto). Sem 3D e sem herói. O lead entra no mesmo registro da página, marcado
`utm_source=site` e `utm_medium=formulario-home` quando a visita não traz origem própria (UTM ou clique de anúncio).

- **Cabeçalhos só nessa rota:** `frame-ancestors https://wingscompany.com.br https://www.wingscompany.com.br` (com
  `base-uri`, `object-src` e `form-action` iguais) e sem `X-Frame-Options`. Todo o resto, 404 inclusive, segue com
  `frame-ancestors 'none'` e `DENY`. A troca é um `map` em `docker/landing-nginx.conf` (um `add_header` dentro de um
  `location` derrubaria os demais cabeçalhos do servidor).
- **Tags:** o embed carrega o mesmo GTM da página (`LANDING_GTM_ID`), que traz o script do RD (identificador
  `lead-form`), GA4, Google Ads e Meta. **O site não pode disparar conversão própria** ao ouvir `wings-lead`: contaria
  em dobro.
- **Endereço (o site repassa):** `utm_*` e demais chaves de origem, `gclid`, `fbclid`, `ref` (a origem da visita),
  `pagina` (o endereço da página do site, só aceito se for do site) e `titulo=1` (mostra título e subtítulo).
- **Mensagens ao site (`postMessage`, só para os domínios do site):** `{tipo:"wings-form-altura", altura}` a cada
  mudança de altura e `{tipo:"wings-lead", origem:"site-home"}` quando o lead é enviado. O site confere
  `event.origin === "https://fale.wingscompany.com.br"`. O botão de WhatsApp da tela de agradecimento abre em outra aba.
- **Esquema de cores:** o embed fica `color-scheme: light` de propósito; o iframe do site leva
  `style="color-scheme: light"`, senão o navegador pinta um fundo opaco por cima da transparência.
- **Snippet do site:** `apps/landing/e2e/site-snippet.html` (o mesmo que o e2e executa).
- **Testes:** `pnpm --filter @wings/landing test:embed` (navegador: o site, o iframe, as mensagens, a transparência, o
  POST, o GTM e o bloqueio de quem não é o site) e `test:nginx` (a configuração real do nginx num container).

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
  640 px valem `data-l` e `data-p`, como antes. Nessa vista o ponto encolhe junto com a figura: tamanho cheio com
  escala 0,5 ou mais (`DOT_REF`), até 60% (`DOT_MIN`) com escala 0,3 ou menos. Sem isso a asa a 57% mantinha o
  ponto e ficava com ~3 vezes mais cobertura, um borrão; `window.__wings3d().tamanhoPonto` mostra o valor.
- O espaço do Turnstile já tem a altura do widget desde o primeiro quadro (sem pulo de layout).
- Freio automático (`brake.ts`), só em celular com toque e com movimento: se a mediana de 60 quadros passar de 24 ms
  (menos de uns 40 quadros por segundo), a cena desce um degrau de resolução (2, 1,5, 1,25, 1) e nunca sobe sozinha.
  Ignora os 20 primeiros quadros e intervalos de mais de 250 ms (aba em segundo plano). `window.__wings3d()` mostra
  `degrau` (0 é o primeiro), `degraus` e `freio`. Para medir a cena sem o freio: `?freio=0` na URL.

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
- Os eventos para o servidor no navegador do Instagram (só Chromium headless no e2e) e o `jq` no servidor de staging.
- A prévia do link (imagem OG) no WhatsApp e no Facebook.
- O nginx no Coolify (só conferido num contêiner local, sem porta publicada): hosts, raiz, 302, 404, `/healthz`,
  cabeçalhos e cache.
- Os registros A dos hosts de staging.
