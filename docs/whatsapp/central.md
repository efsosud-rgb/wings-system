# Central WhatsApp (fase 1)

Pedido do Eric de 26/10/2026: uma central onde a equipe atende pelo número oficial e pelos números de trabalho da
empresa, no caminho **oficial da Meta** (Cloud API com coexistência, Embedded Signup do app Wings CRM Vendas). Nada
de Z-API nem de biblioteca não oficial. Migração **0098** (`0098_wa_central`). Conexão de número: veja também
`conectar-numero.md`; regras do número oficial: `cloud-api.md`; modelos: `modelos.md`.

**Nesta fase ninguém conecta número.** O Admin Master cadastra e confere; a conexão fica pronta para quando a Meta
liberar o app (Tech Provider e App Review, ainda não pedidos).

## O que é

- **Número oficial** (o canal de hoje): conversas por negociação, Sofia, triagem, modelos, janela de 24 h por
  telefone. Nada mudou nele, salvo que as consultas da caixa oficial agora ignoram as conversas dos números de
  trabalho (`number_id is null`).
- **Número de trabalho** (`wa_numbers`): o WhatsApp Business de uma pessoa ou de um setor, que continua no celular.
  Conectado por coexistência, tudo o que passa nele entra no sistema como **uma conversa por número e pessoa**
  (`wa_conversations.number_id`), como no celular. A Sofia e a triagem nunca entram nessas conversas.

## Telas

- **CRM Vendas › WhatsApp** (`/crm-vendas/whatsapp`), em três áreas:
  - **Lista:** nome (da negociação, o salvo no celular do dono ou o perfil), telefone, prévia, hora, não lidas,
    situação da última mensagem, número da empresa ("Oficial" ou o nome do número), "Sofia" ou "Pessoa" e o
    responsável (o dono da negociação; sem negociação, o dono do número). Busca por nome, telefone e texto. Abas:
    Todas, Não lidas, Sem resposta, Minhas, Sem responsável, Pessoa, Sofia. Filtros: número, departamento (do número),
    situação e período (dia da última mensagem, horário de São Paulo). 50 por vez, com "Carregar mais conversas".
  - **Conversa:** a mesma do sistema (mídia, citação, reações, enviado/entregue/lido/falha, modelos e anexos no
    número oficial). Carregando, erro com o motivo, e "Reconectando…" quando uma atualização falha (o que já
    chegou fica na tela).
  - **Contato:** com negociação, empresa, negociação (link), funil, etapa, dono, valor, previsão, origem, entrada,
    tarefas abertas, anotações e arquivos. Sem negociação, as negociações daquele telefone para escolher; sem
    nenhuma, "criar negociação" (a regra do cadastro manual, sem duplicar).
  - Filtros e conversa aberta ficam no endereço (`?filtro=&numero=&setor=&situacao=&de=&ate=&busca=`): o link da
    negociação leva o caminho de volta, e a negociação mostra **"‹ Voltar à conversa"**.
  - **Nova conversa:** "Enviar por" o número oficial (modelo fora das 24 h) ou por um número de trabalho conectado
    que a pessoa alcança. **WhatsApp** nas fichas de contato e de empresa abre a Nova conversa já buscando.
- **CRM Vendas › WhatsApp › Números** (`/crm-vendas/whatsapp/numeros`, Admin Master): cadastrar e editar (nome,
  número, dono, departamento, "Pode conectar?" `a_confirmar | confirmado | inelegivel`, anotações, checagem do
  celular), por número a conexão, o vencimento do acesso da Meta, contatos e histórico; **Conectar pela Meta** só
  em número confirmado; **Avisos da Meta com falha** com "Processar de novo".
- **Página WhatsApp da negociação:** mostra só a conversa oficial e, quando houver, "Também pelo WhatsApp de: …"
  com o link para a conversa do número na Central.

## Regras

### Números de trabalho

- O número oficial (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID` ou o telefone de `WINGS_WHATSAPP_NUMBER`) nunca
  é cadastrado nem conectado como número de trabalho (409 `official_number`), e uma mudança do webhook com o id dele
  nunca é lida como de um número de trabalho. Antes disso, conectar o oficial na tela Números fazia o sistema
  ignorar o canal oficial sem erro.
- Só número **confirmado** é conectado (409 `not_eligible`); só o número cadastrado é aceito da janela da Meta (409
  `number_mismatch`); o número de uma linha conectada não muda (409 `phone_locked`).
- Número pessoal só com avaliação e autorização do Eric (regra da coexistência): a tela diz isso, e a decisão fica
  nas anotações e em "Pode conectar?".
- **Acesso da Meta:** o token da conexão é guardado cifrado (`INTEGRATIONS_ENCRYPTION_KEY`) com o vencimento que a
  Meta der (`expires_in`). A tela avisa a partir de 10 dias. Renovar: refazer o Embedded Signup ("Conectar de novo
  pela Meta", com o celular do dono) ou configurar um token que não vence na Meta, escolha do Eric (detalhes em
  `conectar-numero.md`).

### Conversas dos números

- Entram: as mensagens da pessoa (`messages`), o que o dono manda do celular ou de aparelho vinculado
  (`smb_message_echoes`, autor `app`, "enviada"), o histórico que a Meta manda uma vez (`history`: até 180 dias, só
  conversas individuais, com a data original, nunca contado como "não lida") e o nome que o dono salvou no celular
  (`smb_app_state_sync`, mostrado na lista). O id da Meta é guardado como `<número>:<wamid>`, para dois números
  nossos conversando não virarem uma mensagem só.
- **O histórico precisa estar pronto antes de conectar:** a Meta só aceita o pedido nas primeiras 24 h e manda uma
  vez. Este código já lê o histórico; o que chegar antes dele fica no bruto por 90 dias e se perde.
- Nunca vão para a Sofia nem para a triagem; não abrem a janela de 24 h nem mexem no descadastro do número oficial
  (`wa_contacts.last_inbound_at`, `opt_out_at`).
- **Envio:** com o token do próprio número, texto livre e arquivo da negociação, só dentro de 24 h da última
  mensagem da pessoa **para aquele número**. Modelo e pedido de ligação por número de trabalho: 409
  `number_templates_soon` (os modelos são da WABA de cada número; fase 2). A trava "em breve" dos vendedores é do
  número oficial e não vale para o número de trabalho conectado.
- Arquivos recebidos: copiados para o R2 com o token do próprio número (`media-store.ts`); abrir segue a regra de
  acesso da conversa.

### Ligação com o CRM

- Telefone normalizado (`canonicalWhatsAppPhone`, `brazilianPhoneVariants`), do lead ou de um contato do lead.
- Uma conversa de número entra numa negociação **sozinha só quando há exatamente uma negociação aberta** com o
  telefone. Com várias, ou nenhuma, a pessoa escolhe no painel (`POST /whatsapp/conversations/:id/link`, só entre
  as negociações daquele telefone no alcance dela). Ligar grava `lead.whatsapp_linked` no histórico da negociação
  ("Conversa do WhatsApp ligada a esta negociação") e `whatsapp.conversation_linked` na auditoria (ids).
- O número oficial segue como antes (a negociação aberta mais recente do telefone), porque mudar isso empurraria
  mensagens para a triagem e criaria negociações duplicadas.

### Acesso

- Conversa de número: o **dono do número** e quem lê todas as negociações (`leads.whatsapp` escopo total: Admin
  Master, Diretoria, Gerente Comercial). Vale para lista, conversa, arquivo, envio e ligação com negociação. Um
  vendedor dono da negociação mas não do número **não** vê a conversa daquele número (decisão aberta para o Eric).
- Número oficial: sem mudança (dono da negociação; sem negociação, escopo total).
- A tela da Sofia nunca lista conversa de número. O cadastro, a conexão e os avisos com falha são do Admin Master
  (`integrations.manage`). Auditoria só com ids: `whatsapp.number_registered`, `whatsapp.number_updated` (nomes dos
  campos, nunca valores), `whatsapp.number_connected`, `whatsapp.number_retried`, `whatsapp.message_sent` (com
  `numberId`), `whatsapp.conversation_linked`, `whatsapp.webhook_event_retried`.
- `wa_numbers`, `wa_conversations`, `wa_messages` e `wa_webhook_events` continuam sem GRANT ao `wings_ro`.

### Fila do webhook

- Um corpo novo é processado na hora; um que falhou espera **2, 4, 8 e 16 minutos** (`next_attempt_at`) e, na
  quinta falha, fica `failed`. O Admin Master vê esses avisos (recebido, tentativas, código do erro, nunca o
  conteúdo) e manda **processar de novo** (volta a `pending` com zero tentativas). Processar de novo é seguro: cada
  mensagem entra uma vez só. Corpo já apagado pela limpeza de 90 dias não volta (409).

## Não verificado ao vivo

Nenhum número foi conectado e nada foi chamado na Meta. Os formatos de `smb_message_echoes`, das conversas de
`history` (incluindo `history_context.status` e quem é o remetente), de `smb_app_state_sync` e do erro 2593109
seguem a referência da Meta, com dados inventados nos testes (`central.test.ts`). A mídia do histórico (ids que a
Meta manda à parte, só dos últimos 14 dias) não é lida. O log `whatsapp webhook` mostra o formato de cada corpo
para conferir no primeiro número conectado.

## Variáveis de ambiente (só nomes)

Nenhuma nova. Usadas: `WHATSAPP_APP_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ES_CONFIG_ID`,
`INTEGRATIONS_ENCRYPTION_KEY` (conexão e token dos números), `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_WABA_ID` (número oficial), `WINGS_WHATSAPP_NUMBER` (telefone oficial, para recusar o cadastro dele).

## Passo a passo do Eric com o celular (quando a Meta liberar)

Antes, uma vez, na Meta: app Wings CRM Vendas como Tech Provider, Acesso avançado a `whatsapp_business_management` e
`whatsapp_business_messaging` (Análise do app), configuração do Embedded Signup (`WHATSAPP_ES_CONFIG_ID`; se quiser
token que não vence, escolher aqui), e no webhook os campos `account_update`, `history`, `smb_app_state_sync` e
`smb_message_echoes` além dos de hoje.

Por número:

1. Em **Números**, cadastrar (ou editar) o número com o dono e o departamento.
2. Com o dono, conferir no celular e marcar a checagem: app WhatsApp Business **2.24.17 ou maior** (Configurações ›
   Ajuda › Informações do app); o número é **de trabalho** (pessoal só com a sua autorização, anotada); o dono vai
   estar **com o celular na mão** na hora; ele vai **autorizar o histórico** na hora (a Meta só manda nas primeiras
   24 h).
3. Mudar "Pode conectar?" para **Confirmado**.
4. Na hora combinada, com o celular do dono na mão e o WhatsApp Business aberto: **Conectar pela Meta** na linha.
   Na janela da Meta, entrar com a conta que administra o portfólio, escolher o número que já está no app, ler o QR
   code no celular e aceitar compartilhar o histórico.
5. A linha mostra "Conectado", "vence em …", contatos e histórico pedidos. Deixar o app aberto no celular até o
   histórico chegar a 100%. Se algo falhar nas primeiras 24 h, **Tentar de novo**.
6. Lembrar o dono de abrir o app no celular pelo menos a cada ~14 dias (senão a Meta desconecta o número).

## Riscos

- Nada rodou contra a Meta: o primeiro número conectado é o teste real dos formatos.
- Token de 60 dias: sem a renovação, o número para de enviar e de baixar arquivos no vencimento (a tela avisa).
- Pela auditoria, a **Sofia está ligada no staging** (`sofia.enabled` em 14/10, sem `sofia.disabled` depois); este
  trabalho não mudou a configuração. Ela continua só no número oficial.
- Os modelos da WABA oficial ficam de fora dos números de trabalho; fora das 24 h, a conversa de um número só
  continua quando a pessoa escrever.
- Um vendedor não vê a conversa de outro número sobre a negociação dele (decisão para o Eric).
- A trava contra conexão dupla é do processo da API (um contêiner).

## Ordem de merge e rollback

- Ordem exigida: **#26 (0096, já na `develop`) → #9 (0097) → #10 → #12 → esta (0098)**, com `when` crescente
  (`journal.test.ts`). Quem entrar depois renumera para o próximo número livre.
- **Rollback do código:** reverter o merge. **Rollback do banco** (só se nenhum número tiver sido conectado; com
  conversas de número, apague antes as mensagens e conversas com `number_id`):

```sql
DROP INDEX "wa_conversations_number_contact_uq";
DROP INDEX "wa_conversations_contact_lead_uq";
DROP INDEX "wa_conversations_contact_unmatched_uq";
DROP INDEX "wa_numbers_phone_uq";
ALTER TABLE "wa_conversations" DROP COLUMN "number_id", DROP COLUMN "phone_contact_name";
ALTER TABLE "wa_webhook_events" DROP COLUMN "next_attempt_at";
ALTER TABLE "wa_numbers" DROP COLUMN "phone", DROP COLUMN "label", DROP COLUMN "sector",
  DROP COLUMN "eligibility", DROP COLUMN "eligibility_notes", DROP COLUMN "checks",
  DROP COLUMN "token_expires_at", DROP COLUMN "created_by", DROP COLUMN "created_at";
DELETE FROM "wa_numbers" WHERE "phone_number_id" IS NULL; -- cadastros nunca conectados
ALTER TABLE "wa_numbers" ALTER COLUMN "phone_number_id" SET NOT NULL, ALTER COLUMN "waba_id" SET NOT NULL,
  ALTER COLUMN "token_enc" SET NOT NULL, ALTER COLUMN "connected_at" SET NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'connected';
CREATE UNIQUE INDEX "wa_conversations_contact_lead_uq" ON "wa_conversations" ("contact_id","lead_id")
  WHERE "lead_id" IS NOT NULL;
CREATE UNIQUE INDEX "wa_conversations_contact_unmatched_uq" ON "wa_conversations" ("contact_id")
  WHERE "lead_id" IS NULL;
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1793036092766;
```

## Fases 2 e 3

- Fase 2: atribuição e filas, transferência com aviso ao novo dono, resolver e reabrir, "outra pessoa está
  respondendo"; controles da Sofia por conversa; modelos por número (sincronizar os modelos de cada WABA).
- Fase 3: indicadores (o DW do #25), tela de configuração completa.
