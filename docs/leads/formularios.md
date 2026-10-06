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

**Formulário do site** (`/lp/<slug>`): a página pede Nome da empresa, Instagram e Site (com
"não tenho" valendo como resposta) e CNPJ opcional. A API aceita uma página antiga sem eles. O
campo do site se chama `siteUrl`, porque `website` é a armadilha anti-robô.

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
