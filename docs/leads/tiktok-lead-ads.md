# TikTok Lead Ads → Funil

Os formulários de lead da TikTok entram direto no Wings System, pelo mesmo caminho dos da Meta depois de lidos: junção por telefone e e-mail (`upsertLead`), rodízio do funil, aviso de chegada com prazo de 1 hora útil, backfill sem aviso de 1 hora (lead com mais de 24 h) e mapeamento de formulário → cliente/funil/marca.

> **Não verificado ao vivo.** Nenhum lead real da TikTok passou por este código. O leitor aceita vários nomes para cada campo e o log guarda só o **formato** de cada corpo (nomes de chaves e números, nunca um valor). No primeiro lead real, conferir o log `lead webhook source=tiktok_leads` e ajustar os nomes se preciso. Nenhum lead de teste é criado na TikTok nem em formulário algum: o teste do primeiro lead real é um envio de uma pessoa do time por um formulário já publicado, combinado com o Eric.

## A porta

`POST /api/integrations/tiktok/leads/webhook` (mesma origem, sem CORS).

- **Segredo** (`TIKTOK_LEADS_WEBHOOK_SECRET`, 16+ caracteres, só no Coolify): cabeçalho `X-Wings-Webhook-Secret`, ou `Authorization: Bearer <segredo>`, ou `?secret=` na URL. Comparação em tempo constante (SHA-256 dos dois lados, `timingSafeEqual`). Sem segredo ou errado → 401 e nada gravado; sem a variável no servidor → 503, nunca um 200 falso. Preferir o cabeçalho; a URL com `?secret=` só quando o remetente não deixa pôr cabeçalho (o log da API não grava a query).
- **Corpo**: JSON ou `application/x-www-form-urlencoded` (é o padrão do Webhooks by Zapier). Aceita um lead, uma lista, ou envelope (`leads`, `data`, `lead`, `events`...).
  - Formato da própria TikTok ("Custom API with Webhooks"): `lead_id`, `form_id`, `form_name`, `campaign_id/name`, `adgroup_id/name`, `ad_id/name`, `create_time` e as respostas em `user_info` (lista de pergunta/resposta, ou mapa).
  - Formato do Zapier (TikTok Lead Generation → Webhooks): linhas planas com os rótulos do Zapier (`Lead ID`, `Full Name`, `Email`, `Phone Number`, `Form ID`, `Campaign Name`, `Created Time`, mais uma chave por pergunta do formulário).
- **Resposta**: `{received, created, merged, skipped, failed, rdCreated}`, só números. 200 mesmo quando o lead não tem telefone nem e-mail (`skipped`: o remetente não deve repetir). Falha nossa → **500**, e o remetente tenta de novo; o id do lead (`external_id`) torna a repetição inofensiva.
- Não há fila: o lead é criado antes do 200 (o corpo já traz as respostas; não há o que ler de volta).

## Regras de funil e marca

Em **CRM Vendas → Landing pages → Outras origens**: tipos "Formulário do TikTok Lead Ads (id do formulário)" e "Campanha do TikTok (id da campanha)" (`tiktok_form`, `tiktok_campaign`). O formulário vence a campanha. Sem regra: o nome do formulário decide (contém "formatação" → Formatação; nome de marca cadastrada em Expansão → Expansão com a marca); senão Formatação, marcado como palpite, e a Diretoria recebe **um** aviso por formulário.

## Cópia para o RD CRM

Interruptor próprio: `TIKTOK_LEADS_RD_COPY_ENABLED`, **desligado a menos que seja `true`** (e exige `RD_CRM_API_TOKEN`). Desligado no staging. Só para lead **nascido** aqui (uma repetição ou junção não chama o RD); um POST só, nunca repetido; Formatação → "Sem contato", Expansão → "Novo Contato"; Origem tenta "TikTok Lead Ads", "TikTok Ads", "TikTok" e fica vazia se nenhuma existir; OBS traz plataforma, formulário, campanha, conjunto e anúncio, nunca a pessoa. O resultado (`rd=created|existing_deal|failed|unknown|...`) vai ao log por lead; diferente da Meta, não há tabela de fila para consultar depois.

## Cartão na tela de Integrações

Administração → Integrações → **Fontes de negócios**: "TikTok Lead Ads", ligada/desligada conforme o segredo, com a contagem dos últimos 30 dias e "última há …" (lidos de `leads.source = tiktok_lead_ads`).

## O que o Eric faz

Segredo (os dois caminhos): criar `TIKTOK_LEADS_WEBHOOK_SECRET` no Coolify (frase longa, só letras e números), pedir o deploy. URL: `https://wingssystem.online/api/integrations/tiktok/leads/webhook` (staging: `https://staging.wingssystem.online/...`).

**Caminho A — Zapier (recomendado para começar).** O app "Webhooks by Zapier" é premium: exige plano pago (conferir o plano e o preço atuais na Zapier).
1. Ter/assinar um plano da Zapier com Webhooks.
2. Novo Zap, gatilho **TikTok Lead Generation → New Lead**; conectar a conta (login do TikTok for Business que administra a conta de anúncios do formulário); escolher a conta de anúncios e o formulário.
3. Ação **Webhooks by Zapier → POST**; URL acima; Payload Type **Json** (ou Form); Data: mapear todos os campos do gatilho; Headers: `X-Wings-Webhook-Secret` = o segredo.
4. Testar o Zap só com os dados de exemplo da própria Zapier (sem criar lead na TikTok); publicar.

**Caminho B — API da TikTok (Custom API with Webhooks).** Mais trabalho e prazo fora do nosso controle.
1. App de desenvolvedor no portal TikTok for Business (Marketing API) aprovado, com permissão de Lead Generation / Leads.
2. Autorizar a conta de anúncios nesse app; configurar a URL do webhook (com `?secret=` se o painel não aceitar cabeçalho).
3. Conferir no log o primeiro corpo real e me chamar para ajustar os nomes.
Os passos exatos dos painéis da TikTok **não foram conferidos aqui**; o Eric confere na tela e me diz o que apareceu.

**Recomendação:** começar pelo A. Sai em um dia, sem aprovação de app; o B só vale se o volume ou o custo da Zapier justificar. A mesma porta serve aos dois, então trocar depois não muda nada do nosso lado.

## Variáveis (só nomes)

`TIKTOK_LEADS_WEBHOOK_SECRET`, `TIKTOK_LEADS_RD_COPY_ENABLED`, `RD_CRM_API_TOKEN`, `EXPANSION_OWNER_RD_USER_ID`. Valores só no Coolify.

## Sem migração

Nada novo no banco: `source`, `channel` e `kind` das regras são texto. A porta fica só no código.
