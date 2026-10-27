# Conectar o número de um vendedor (coexistência)

Ordem do Eric de 20/10/2026 (opção 1, "espelho"): os 6 números de WhatsApp Business dos vendedores continuam no
celular de cada um e o sistema espelha as conversas. Este é o bloco **a1**: a tela que conecta o número e guarda a
conexão. Espelhar as mensagens no CRM vem depois. Migração **0095** (`wa_numbers`).

## Como se usa

1. **CRM Vendas › WhatsApp › Números dos vendedores** (`/crm-vendas/whatsapp/numeros`). Só o Admin Master
   (`integrations.manage`, a mesma permissão da chave do número oficial).
2. Escolher o **dono do número** entre os vendedores ativos (a lista de donos de negociação).
3. Com o **celular do vendedor na mão** e o WhatsApp Business aberto, clicar em **Conectar pela Meta**. Na janela da
   Meta: entrar com a conta que administra o portfólio, escolher usar o número que já está no app WhatsApp
   Business, ler o QR code no celular e **aceitar compartilhar o histórico** (recusar deixa sem histórico).
4. A tela mostra o número na lista: situação, contatos, histórico (em %, pelo webhook) e até quando dá para pedir o
   que faltou. **Deixar o WhatsApp Business aberto no celular** até o histórico chegar a 100%.

## O que o sistema faz

- O navegador carrega o SDK oficial da Meta (`connect.facebook.net`) só nesta tela e abre o Embedded Signup com
  `config_id` = `WHATSAPP_ES_CONFIG_ID`, `response_type: code` e, em `extras`, `featureType:
whatsapp_business_app_onboarding` (o exemplo da página de coexistência da Meta).
- A janela da Meta manda o evento `WA_EMBEDDED_SIGNUP` com `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` e o `waba_id`
  (lido só de origem `https://*.facebook.com`); o `FB.login` devolve o `code`, que vale **30 segundos** e vai direto
  para `POST /whatsapp/numbers/connect`. Outro tipo de conclusão (número novo) é recusado: este fluxo não registra
  número.
- A API, nesta ordem:
  1. confere que o dono é um vendedor ativo (antes de falar com a Meta);
  2. troca o `code` pelo token da empresa (`GET /oauth/access_token` com `WHATSAPP_APP_ID` e `WHATSAPP_APP_SECRET`);
  3. lê com esse token os números da WABA (`GET /{waba}/phone_numbers`): um id do navegador só vale se a Meta o
     mostrar; `is_on_biz_app: false` é recusado;
  4. lê o portfólio dono da WABA (`owner_business_info`);
  5. grava o número com o token **cifrado** (`secret-box.ts`, `INTEGRATIONS_ENCRYPTION_KEY`);
  6. assina os webhooks da WABA (`POST /{waba}/subscribed_apps`);
  7. pede os contatos (`POST /{número}/smb_app_data`, `smb_app_state_sync`) e depois o histórico (`history`).
     Tudo antes do passo 5 é leitura: uma recusa ali não grava nada. Não chama `/register`: o número já está
     registrado no app.
- A Meta aceita cada pedido de sincronização **uma vez por conexão**, nas **24 horas** seguintes. Se a assinatura
  falhar, os pedidos não saem (os webhooks não chegariam); **Tentar de novo** refaz só o que falhou: a assinatura a
  qualquer hora, os pedidos só dentro das 24 horas. Um pedido sem resposta da Meta (`unknown`) nunca é mandado de
  novo. Para pedir de novo depois das 24 horas, o número precisa sair e conectar outra vez.
- Uma conexão por número de cada vez: um segundo clique enquanto a primeira espera a Meta responde 409 (`busy`), e
  nenhum pedido sai duas vezes. A trava é do processo da API (um contêiner hoje); com réplicas, precisa ir para o
  banco.
- Conectar de novo o mesmo número troca o token e recomeça as 24 horas.
- Webhook (`intake.ts`): toda mudança de um número conectado aqui (pelo número, ou pela WABA quando não é a do
  número oficial) fica fora do CRM. Só duas leem algo: `account_update` com `ACCOUNT_OFFBOARDED` ou
  `PARTNER_REMOVED` (com o motivo de `disconnection_info`) marca o número como desconectado; `history` atualiza o
  progresso (o maior valor). Mensagens, ecos (`smb_message_echoes`), histórico e modelos desses números ficam
  guardados em `wa_webhook_events` (o texto é apagado em 90 dias) e ainda **não** entram no CRM, isso é o bloco
  seguinte (que precisa vir antes dos 90 dias para aproveitar o histórico).

## Ordem de entrada

A 0095 vem depois da 0094 do pacote de 20/10 (`integ/staging-2026-10-20`). **Este PR só entra na develop depois
daquele pacote**, e nenhum banco roda a migração entre um e outro: o drizzle aplica por data, e uma 0094 que chegue
depois de uma 0095 já aplicada é pulada sem erro.

## Regras

- Um portfólio não é presumido: cada número guarda a própria WABA, o portfólio e o token que a Meta deu na conexão
  dele. Conectar um número nunca troca o token de outro.
- O token nunca vai ao navegador, a log ou a resposta; a auditoria (`whatsapp.number_connected`,
  `whatsapp.number_retried`) guarda só ids e o resultado de cada passo.
- `wa_numbers` não tem GRANT ao `wings_ro` (guarda o token cifrado).

## Variáveis

`WHATSAPP_ES_CONFIG_ID` (novo, não secreto: o ID da configuração do Facebook Login for Business), mais as que já
existem: `WHATSAPP_APP_ID`, `WHATSAPP_APP_SECRET`, `INTEGRATIONS_ENCRYPTION_KEY`. Faltando alguma, a tela diz qual
(só o nome) e a conexão responde 503.

## Na Meta (app "Wings CRM Vendas")

- Ser Tech Provider, com acesso avançado a `whatsapp_business_management` e `whatsapp_business_messaging` (Análise
  do app).
- Produtos WhatsApp e Facebook Login for Business; configuração "WhatsApp Embedded Signup" (v4) → o ID vai em
  `WHATSAPP_ES_CONFIG_ID`.
- Facebook Login for Business › Settings: Client OAuth login, Web OAuth login, Enforce HTTPS, Embedded Browser OAuth
  Login, Use Strict Mode for redirect URIs e Login with the JavaScript SDK ligados; o domínio do staging e a página
  `/crm-vendas/whatsapp/numeros` em "Allowed domains for the JavaScript SDK" e em "Valid OAuth redirect URIs".
- Webhook: a URL de sempre (`/api/integrations/whatsapp/webhook`), com os campos `account_update`, `history`,
  `smb_app_state_sync` e `smb_message_echoes` além dos que já estão.

## Não verificado ao vivo

Nada disso rodou contra a Meta: o app ainda não é Tech Provider. Em aberto: se uma configuração v4 ainda lê
`featureType` em `extras` (a Meta diz que os `extras` da v4 são vazios); se o evento traz `phone_number_id` (a página
de coexistência mostra só o `waba_id`; a API escolhe o número da WABA que está no app); o formato de
`owner_business_info`, de `account_update` e do progresso do `history`; se um app em modo de desenvolvimento
completa o fluxo. O log `whatsapp webhook` mostra o formato de cada corpo para conferir.
