# Central WhatsApp (fase 1)

Pedido do Eric de 26/10/2026: uma central onde a equipe atende pelo número oficial e pelos números de trabalho da
empresa, no caminho **oficial da Meta** (Cloud API com coexistência, Embedded Signup do app Wings CRM Vendas). Nada
de Z-API nem de biblioteca não oficial. Migração **0100** (`0100_wa_central`). Conexão de número: veja também
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
  mensagem da pessoa **para aquele número**; fora delas, um modelo aprovado **da WABA daquele número** (fase 2b:
  `GET /whatsapp/templates?numberId=`, sincronizado com o token do número em `wa_number_templates`; nunca os
  modelos oficiais). O pedido de ligação continua só no número oficial (409 `number_no_calls`). Quem pediu para
  não receber mensagens (SAIR) não recebe modelo por nenhum número nosso: só resposta dentro das 24 h. A trava "em
  breve" dos vendedores é do número oficial e não vale para o número de trabalho conectado.
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
- **Número em atendimento (WA-03):** um número que a Sofia ou a equipe atende sem negociação (o "ocupado" de
  `GET /whatsapp/targets`) não vira negociação de vendedor, nem pela criação (`POST /leads`, importação) nem como
  **contato** de uma negociação dele: `POST /leads/:id/contacts` (contato digitado ou já existente) e a troca de
  telefone em `PATCH /crm/contacts/:id` respondem 409 `number_in_attendance` para quem tem escopo próprio, antes
  de gravar qualquer coisa, porque a próxima mensagem levaria a conversa para essa negociação. Quem distribui
  negociações (escopo total) continua vinculando, e a conversa vai para a negociação na próxima mensagem. Conversa
  encerrada não é de ninguém. Vínculos feitos antes desta trava não foram desfeitos (`DUVIDAS.md` da execução wa03).
- **Não me contate no contato vinculado:** a conversa que entrou numa negociação pelo telefone de um contato é
  conferida pelo telefone da própria conversa e pelo id da negociação (`contactBlock`): um registro no telefone do
  contato, ou na negociação, recusa o modelo com 409 `contact_blocked` e grava `lead.contact_blocked`
  (`central-linked-contact.test.ts`).

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

### Atendimento: quem responde cada conversa (fase 2, migração 0101)

- **Quem está com a conversa:** a pessoa atribuída; sem atribuição, o dono da negociação (número oficial) ou o dono
  do número (número de trabalho); sem nenhum, ela espera na **fila** do departamento (`wa_conversations.queue`) ou
  sem fila. A lista mostra essa pessoa como responsável (ou "fila <departamento>"); a aba **Minhas** e **Sem
  responsável** usam a mesma regra, e o filtro **Departamento** lê a fila e, sem ela, o departamento do número.
- **Trava:** só quem está com a conversa escreve. Quem mais a vê recebe 409 `not_holder` ("Esta conversa está com
  Fulano. Assuma a conversa antes") e a tela troca o campo de texto pelo aviso; **Assumir** passa a conversa para
  a pessoa e avisa quem estava com ela (CRM Vendas › Avisos). Ninguém com ela: quem escreve primeiro fica com ela.
  Uma mensagem de uma pessoa **suspende a Sofia** na hora, antes de sair (estado "Com vendedor").
- **Passar para:** quem lê todas (Admin Master, Diretoria, Gerente Comercial; quem vê a equipe) passa para uma
  pessoa ativa que atende pelo WhatsApp (ela recebe o aviso e a conversa entra em Minhas); quem está com a conversa
  (ou quem lê todas) manda para a fila de um departamento (só conversa sem dono de negociação nem de número; com
  dono, 409 `has_owner`). A pessoa que recebe uma conversa passa a vê-la, mesmo sem ser dona da negociação.
- **Resolver e reabrir:** resolver encerra e guarda quem estava com ela; reabrir volta para essa pessoa (ou para a
  fila). Se a própria pessoa escreve numa conversa resolvida, ela recomeça pela regra de 07/10 (dono da
  negociação, Sofia ou atendente) e a atribuição antiga sai.
- **"Está respondendo":** enquanto alguém digita, quem mais abre a conversa vê "Fulano está respondendo…" (dura
  45 s sem nova digitação).
- **Versão (compare-and-set):** cada troca de mãos soma 1 em `wa_conversations.version`; a tela manda a versão que
  viu e uma ação sobre versão antiga recebe 409 `conversation_changed` ("A conversa mudou de mãos agora"). O turno
  da Sofia compara a versão também: se uma pessoa assumiu (mesmo que tenha devolvido) enquanto ela pensava, nada
  sai. A mensagem que chega trava a linha da conversa antes de decidir quem atende.
- **Distribuição** (`whatsapp_settings.assignment_mode`, quem tem `crm.manage` muda na Central): **Fica na fila até
  alguém assumir** (padrão) ou **Rodízio do funil**: uma conversa que espera e não tem ninguém vai para a próxima
  pessoa do rodízio do funil da negociação (ou do assunto que a Sofia descobriu), o mesmo `crm_distribution_members`
  das negociações, com aviso. Sem funil conhecido, fica na fila.
- **Histórico:** `wa_conversation_events` (só ids e códigos): assumiu, transferiu, mandou para a fila, rodízio,
  resolveu, reabriu, pausou e ligou a Sofia, a Sofia passou para uma pessoa (com o motivo), a Sofia parou por
  mensagem de uma pessoa. O painel da conversa mostra o histórico e **o que a Sofia deixou** (motivo e o que ela
  descobriu). Auditoria: `whatsapp.conversation_taken`, `_transferred`, `_queued`, `_resolved`, `_reopened`,
  `sofia.paused`, `sofia.resumed`, `whatsapp.assignment_mode_changed`.
- **Sofia por conversa** (só número oficial): **Pausar a Sofia** (quem vê a conversa, com a Sofia ligada): ela para e
  não pega mais essa conversa, nem quando ela é resolvida e a pessoa volta; **Ligar a Sofia** (quem tem
  `sofia.read`, com a Sofia ligada): ela responde a próxima mensagem da pessoa. A Sofia continua **desligada por
  padrão** (`sofia_settings.enabled`); nada aqui a liga.

Rotas (`leads.whatsapp`, na regra de acesso da conversa): `GET /whatsapp/conversations/:id/attendance`,
`POST …/assign` (`{ version, employeeId | null, queue? }`), `POST …/resolve`, `POST …/reopen`, `POST …/sofia`
(`{ version, action: pause | resume }`), `POST …/replying`; `GET /whatsapp/assignment` e `PUT` (`crm.manage`).

### Fila do webhook

- Um corpo novo é processado na hora; um que falhou espera **2, 4, 8 e 16 minutos** (`next_attempt_at`) e, na
  quinta falha, fica `failed` e **os Admin Masters recebem um aviso** em CRM Vendas › Avisos (fase 2b; uma vez por
  corpo, sem o conteúdo). O Admin Master vê esses avisos (recebido, tentativas, código do erro, nunca o
  conteúdo) e manda **processar de novo** (volta a `pending` com zero tentativas). Processar de novo é seguro: cada
  mensagem entra uma vez só. Corpo já apagado pela limpeza de 90 dias não volta (409).

### Envios sem resposta da Meta (fase 2b)

Uma mensagem nossa sem `wamid` 10 minutos depois (a Meta não respondeu, ou um reinício cortou o envio) pode ter
chegado ou não. A fila (a cada minuto) marca como "sem resposta da Meta" (a bolha diz "pode ter ido ou não") e avisa
quem mandou (os gestores, se foi a Sofia ou o sistema), uma vez, olhando as últimas 24 h. **Nada é reenviado
sozinho**: quem mandou confere a conversa antes de mandar de novo.

## Não verificado ao vivo

Nenhum número foi conectado e nada foi chamado na Meta. Os formatos de `smb_message_echoes`, das conversas de
`history` (incluindo `history_context.status` e quem é o remetente), de `smb_app_state_sync` e do erro 2593109
seguem a referência da Meta, com dados inventados nos testes (`central-fixtures.ts`). A mídia do histórico (ids que a
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
- Token de 60 dias: a renovação (fase 2b) segue a referência da Meta e não foi testada ao vivo; recusada, o número
  para de enviar e de baixar arquivos no vencimento (a tela e os avisos dizem antes).
- Pela auditoria, a **Sofia está ligada no staging** (`sofia.enabled` em 14/10, sem `sofia.disabled` depois); este
  trabalho não mudou a configuração. Ela continua só no número oficial.
- Fora das 24 h, um número de trabalho só fala por modelo aprovado na WABA dele: sem nenhum aprovado lá, só quando
  a pessoa escrever.
- Um vendedor não vê a conversa de outro número sobre a negociação dele (decisão para o Eric).

## Ordem de merge e rollback

- Integrada sobre a `develop` em 29/10, depois da `0098_contact_opt_outs` (#56): #9 (0099) → #10 → #12 → #41
  (0100) → #38 (0101) → #39 (0102), migrations geradas de novo com `when` crescente (`journal.test.ts`). Quem
  entrar depois gera a sua de novo sobre a 0102.
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
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1793292674799;
```

## Fases 2 e 3

- Fase 2a (feita): atendimento (acima) e a Sofia por conversa (`sofia.md`).
- Fase 2b (feita): aviso do webhook que falhou, envios sem resposta da Meta, reserva de conexão no banco,
  renovação do acesso de 60 dias, modelos incompletos recusados, lista da Sofia paginada, modelos por número.
- Fase 3: indicadores (o DW do #25), tela de configuração completa.

## Migração 0101 (fase 2a) e rollback

`0101_wa_attendance` (depois da 0100 da fase 1, `when` crescente). Acrescenta em
`wa_conversations` `assignee_employee_id`, `queue`, `version`, `replying_employee_id`, `replying_until` e
`sofia_paused`; a tabela `wa_conversation_events`; e `whatsapp_settings.assignment_mode` (padrão `manual`). Nada
existente muda de valor. Sem GRANT ao `wings_ro`. Rollback do banco:

```sql
DROP TABLE "wa_conversation_events";
DROP INDEX "wa_conversations_assignee_idx";
ALTER TABLE "wa_conversations" DROP COLUMN "assignee_employee_id", DROP COLUMN "queue",
  DROP COLUMN "version", DROP COLUMN "replying_employee_id", DROP COLUMN "replying_until",
  DROP COLUMN "sofia_paused";
ALTER TABLE "whatsapp_settings" DROP COLUMN "assignment_mode";
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1793292678396;
```

## Migração 0102 (fase 2b) e rollback

`0102_wa_reliability` (depois da 0101): `wa_numbers.connecting_until`,
`token_renew_tried_at` e `token_renew_error`; a tabela `wa_number_templates` (modelos de cada número, apagados com
o número). Nada existente muda de valor. Sem GRANT ao `wings_ro`. Rollback do banco (antes do da 0101):

```sql
DROP TABLE "wa_number_templates";
ALTER TABLE "wa_numbers" DROP COLUMN "connecting_until", DROP COLUMN "token_renew_tried_at",
  DROP COLUMN "token_renew_error";
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1793292681812;
```
