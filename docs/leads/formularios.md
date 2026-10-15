# Formulários de lead: os cinco campos, o Google Ads e a conferência na chegada

## Os campos no lugar próprio

Todo formulário de campanha pede **Nome, WhatsApp, Instagram, Site e Nome da empresa** (e às vezes
CNPJ). Eles deixam de viver só em "Respostas do formulário":

| Campo           | Onde fica no lead                                     | De onde vem                                                             |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| Nome            | `leads.name`                                          | campo da plataforma; se faltar, a pergunta "Nome…"                      |
| WhatsApp        | `leads.phone`                                         | campo da plataforma; se faltar, a pergunta "WhatsApp/celular/telefone…" |
| Instagram       | `leads.instagram` (o @ sem arroba, ou como digitado)  | pergunta "Instagram/@…"                                                 |
| Site            | `leads.website` (endereço completo, ou como digitado) | pergunta "Site/website…" (`siteUrl` no formulário do site)              |
| Nome da empresa | `leads.company_name`                                  | pergunta "Nome da empresa/empresa/marca…" ou `COMPANY_NAME` do Google   |
| CNPJ            | `leads.company_cnpj` (só dígitos)                     | pergunta "CNPJ"                                                         |

O mapeamento é pelo **texto da pergunta**, sem acento e sem diferença de maiúscula
(`leadFieldOfQuestion` em `packages/shared/src/lead-fields.ts`), num lugar só: `upsertLead`
(`withFormFields`). Vale para Meta, TikTok, Google Ads e o formulário do site. As respostas
originais continuam em "Respostas do formulário". Um lead que chega de novo só preenche o que
estava vazio.

**Formulário do site** (`/lp/<slug>`, desde 2026-10-07): a página pede **só as cinco perguntas do
formulário padrão** — Nome, WhatsApp, Nome da empresa, Instagram e Site ("não tenho" vale como
resposta) — as mesmas do formulário instantâneo da Meta. Não pede e-mail nem CNPJ (a API ainda
aceita os dois de uma página antiga; sem e-mail, a cópia ao RD é pulada com `rdForward: no_email`).
O campo do site se chama `siteUrl`, porque `website` é a armadilha anti-robô.

- **Texto pelo funil da página** (`siteFormCopyOf`, `packages/shared/src/leads.ts`): Expansão
  "Seja um franqueado <marca>"; Formatação "Transforme a sua empresa em franquia", botão "Quero
  formatar minha franquia"; Consultoria "Fale com a consultoria da Wings". A linha de consentimento
  também muda e é a que fica gravada no lead (`consent_text`). O funil vem da regra da página em
  CRM Vendas → Landing pages; sem funil na regra, o texto é o de Expansão.
- **Conversão nas plataformas** (`apps/web/src/lib/site-conversion.ts`): a página carrega o pixel
  da Meta (`META_PIXEL_ID`, só com `SITE_FORM_META_PIXEL_ENABLED=true`: PageView ao abrir e `Lead`
  no envio) e a tag do Google Ads (`SITE_FORM_GOOGLE_ADS_CONVERSION=AW-<id>/<rótulo>`, da ação de
  conversão em Metas → Conversões: `conversion` no envio). Sem a variável, o script nem é
  carregado. Nada digitado vai às tags, só o evento. Os ids chegam à página por
  `GET /public/site-forms/:slug` (`tracking`); a página nunca os tem no código.
- Link "Política de Privacidade" quando a página tem o formulário padrão aprovado (`site_form_spec`).
- **Não verificado ao vivo** (2026-10-07): o disparo real do pixel e da conversão do Google só
  pode ser conferido em produção, com os ids definidos (Meta: Gerenciador de Eventos → Testar
  eventos; Google: Metas → Conversões → "Diagnóstico").

## Google Ads (YouTube, Pesquisa) → Funil

`POST /api/integrations/google-ads/leads/webhook`, no padrão do TikTok:

- `GOOGLE_ADS_LEADS_WEBHOOK_KEY` (16+ caracteres, só no Coolify). **Sem a variável: 503. Chave
  errada: 401.** O Google manda a chave no corpo (`google_key`); cabeçalho
  `X-Wings-Webhook-Secret` ou `?secret=` também valem. Comparação em tempo constante.
- Corpo do Google: `lead_id`, `form_id`, `campaign_id`, `adgroup_id`, `creative_id`, `is_test` e
  `user_column_data` (`column_id`, `column_name`, `string_value`). `FULL_NAME`/`FIRST_NAME`+
  `LAST_NAME`, `PHONE_NUMBER`, `EMAIL`, `CITY` e `COMPANY_NAME` vão para os campos; as outras
  colunas são perguntas (respostas do formulário, mapeadas como acima).
- **"Enviar dados de teste" do Google** (`is_test: true`): 200, nenhum lead criado.
- Funil: regra em **CRM Vendas → Landing pages → Outras origens**, tipos "Formulário de lead do
  Google Ads (id do formulário)" e "Campanha do Google Ads (id da campanha)". Sem regra, o lead
  entra no funil padrão (Formatação) e a Diretoria recebe um aviso por formulário: o corpo do
  Google não traz o nome do formulário.
- Origem `google_lead_form` ("Formulário do Google Ads"). Sem cópia ao RD nesta etapa.
- **Não verificado ao vivo.** Feito pelo formato documentado do Google; o log guarda só o
  formato (`lead webhook`, `source: google_leads`, nomes de chaves e números).

**O que o Eric faz:** criar a chave no Coolify (`wings-env set api-prod GOOGLE_ADS_LEADS_WEBHOOK_KEY
--from-file …`), reiniciar a API e, no Google Ads, em cada formulário de lead → "Integração com
webhook": URL `https://wingssystem.online/api/integrations/google-ads/leads/webhook` e a mesma
chave; usar "Enviar dados de teste" (não cria lead). Depois, as regras de funil por formulário.

## Conferência na chegada

Logo depois de gravado o lead (fora da resposta ao remetente) e no botão **Conferir de novo**
(`POST /api/leads/:id/checks`, `leads.write`). O resultado fica em `leads.field_checks` e aparece
em **Origem → Dados do formulário**: Confere, Não confere ou Não verificado, sempre com o motivo;
sem o dado, "—" e "o formulário não trouxe…".

| Conferência | Como                                                                             | Não verificado quando                                                                |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| WhatsApp    | DDD em uso no Brasil (67) e celular (9 depois do DDD); sem rede                  | número de fora do Brasil                                                             |
| Site        | o site responde (2xx/3xx), em até 6 s                                            | não respondeu a tempo, ou a conferência está desligada                               |
| Instagram   | API oficial (Business Discovery) pela conta comercial da Wings                   | conta da Wings não configurada; perfil pessoal ou inexistente (a API não diferencia) |
| CNPJ        | dígitos verificadores; situação na Receita pela BrasilAPI (ReceitaWS de reserva) | a base pública não respondeu                                                         |

- **Segurança (site):** só http/https nas portas 80/443; o nome é resolvido e todo endereço
  precisa ser público, inclusive na hora de conectar e em cada redirecionamento; só a linha de
  status é lida (`apps/api/src/lib/public-probe.ts`).
- **Variáveis:** `INSTAGRAM_DISCOVERY_ACCOUNT_ID` (id numérico da conta comercial do Instagram da
  Wings) e `INSTAGRAM_DISCOVERY_TOKEN` (segredo; token com acesso a Business Discovery);
  `LEAD_CHECKS_ENABLED=false` desliga as conferências que saem do servidor (o WhatsApp continua).
- Nada do lead entra em log: só os status de cada conferência e o formato das respostas do
  Instagram. O token vai em cabeçalho, nunca na URL.
- Formato de erro do Instagram **não verificado ao vivo** (códigos 110, 190, 4/17/32).

## Pesquisa da empresa pela web (OpenRouter)

O ponto de encaixe `LeadResearchProvider` agora tem um provedor: o OpenRouter, com busca na web
de até 5 resultados. Funcionamento, variáveis e limites em
[pesquisa-da-empresa.md](pesquisa-da-empresa.md). O Manus não foi usado.

## Migração

`0072_lead_form_fields`: cinco colunas novas em `leads` (`instagram`, `website`, `company_name`,
`company_cnpj`, `field_checks`). **Número provisório**, à espera da confirmação do orquestrador (a
0071 é do Fable); o `when` dela precisa ficar depois do da 0071.

## Do formulário ao WhatsApp (ref do lead e contexto da Sofia)

Desde 15/10/2026. A página do formulário abre o `wa.me` com o texto `<código do link rastreável> <ref>`: o código do link `site` do cliente e a **ref** do envio (6 caracteres do alfabeto do código, sem 0/O/1/I, sorteados no servidor com gerador criptográfico e gravados em `leads.form_ref`, com `form_ref_at`). Com uma marca, a frase da marca segue depois.

- A ref vale **7 dias** e só a do último envio do mesmo lead. É uma pista que liga a conversa ao lead, nunca uma chave para os dados dele: nada do lead é mostrado a quem mandou a mensagem por causa dela.
- **Cloud API** (`whatsapp/intake.ts`): a primeira mensagem com código e ref liga a conversa ao lead do formulário, mesmo de outro número, e não cria outro lead (com a Sofia ligada ou não). Evento `lead.whatsapp_linked` na linha do tempo.
- **Z-API (0288)** (`/integrations/zapi/webhook`): só a ligação ao lead (evento e contador do link) e o aviso ao dono (`lead_whatsapp`, sem nome); sem conversa própria.
- **Sofia**: ao ligar, as respostas do formulário (nome, empresa, Instagram, site, cidade; "não tenho" vira "Não tem") entram em `sofia_facts.answers`, o funil vem da página e a marca já conta como confirmada; ela só pergunta o que falta. A saudação usa o primeiro nome **só quando o número é o que o formulário deu**; de outro número ela cumprimenta sem nome. A página de origem e as respostas não pessoais do formulário vão ao modelo como `contexto_do_formulario`. A regra de hoje não muda: se o negócio já tem dono, a mensagem é do dono, e a Sofia só entra se ele não tem dono ou o devolveu.
- Sem ref (clique antes do formulário, ref vencida ou desconhecida): fica a triagem e a pré-qualificação de hoje.
