# Não me contate (trava única)

Decisão do Eric em 29/10/2026, 10:31 (`docs/decisoes.md`): um "não me contate" registrado em qualquer lugar impede a Wings de **iniciar** contato pelo canal escolhido, ou por todos, e todo envio do sistema consulta uma função única.

## O cadastro

Tabela `contact_opt_outs` (migration `0098_contact_opt_outs.sql`, schema em `apps/api/src/db/schema/leads.ts`). Uma linha por canal e chave:

- **canal**: `all` (todos), `whatsapp`, `phone`, `email`, `instagram`;
- **chave**: `lead` (id da negociação), `phone`, `email`, `instagram_user`, `place_id`, `cnpj`, sempre na forma de `normalizeContactKey` (`packages/shared/src/contact-opt-out.ts`): telefone por `normalizeBrazilianPhone` com o 9º dígito do celular, e-mail em minúsculas, Instagram sem `@`, CNPJ só dígitos;
- **origem**: `crm`, `whatsapp_palavra`, `prospeccao`, `instagram`, `importacao`;
- motivo, quem registrou (nulo quando foi automático), quando; para revogar, `revoked_at`, `revoked_by` e `revoked_reason`.

Um índice único parcial (tenant, canal, chave, valor) onde `revoked_at` é nulo deixa o registro idempotente: gravar de novo o mesmo não cria linha. Depois de revogado, um novo "não me contate" cria linha nova. Nenhum dado antigo foi copiado: a função lê também as fontes antigas.

## A função única

`contactBlock(db, canal, { leadId, phone, email, instagramUser, placeId, cnpj })` em `apps/api/src/modules/leads/contact-block.ts` devolve `{ blocked, reason, origin }`. Só lê. Junta, nesta ordem:

1. o cadastro, no canal pedido ou em `all`, por qualquer chave conhecida (as do lead entram sozinhas quando vem o `leadId`);
2. `wa_contacts.opt_out_at` (o SAIR do WhatsApp), só para o canal WhatsApp;
3. um prospect `nao_contatar`, por `place_id` ou pelo lead que ele virou, em todos os canais;
4. para o WhatsApp, a regra da prospecção `whatsappOptInMissing`, sem mudança de significado.

## Onde ela é consultada (a Wings inicia o contato)

| Caminho                                                                                                        | Onde                                                               | Quando bloqueia                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Modelo de WhatsApp (pela negociação ou pela conversa), por qualquer número da Central (oficial ou de trabalho) | `apps/api/src/modules/whatsapp/routes.ts` (`send`)                 | 409 `contact_blocked` com o motivo; `opted_out` continua para quem disse SAIR. Conversa sem negociação: conferida pelo telefone |
| Pedido de permissão para ligar, manual                                                                         | idem                                                               | 409 `contact_blocked`                                                                                                           |
| Pedido de permissão para ligar, automático ("Prefiro uma ligação")                                             | `apps/api/src/modules/whatsapp/intake.ts` (`answerCallRequest`)    | nada sai; a tarefa de ligar para o dono continua                                                                                |
| Ligação pelo WhatsApp                                                                                          | `apps/api/src/modules/whatsapp/call-routes.ts`                     | canal WhatsApp **ou** telefone; 409 `contact_blocked`                                                                           |
| E-mail ao lead: manual (modelo ou texto livre), regra de automação e passo de sequência                          | `apps/api/src/modules/leads/automations.ts` (`sendToLead`, também no endereço escolhido) | manual 409 `contact_blocked`; automação e sequência ficam `skipped` com `reason: contact_blocked`; nada no outbox               |
| Sofia                                                                                                          | `apps/api/src/modules/sofia/engine.ts`                             | ver abaixo                                                                                                                      |

Todo bloqueio deixa `lead.contact_blocked` na linha do tempo (canal, caminho, origem; nunca texto, telefone ou e-mail).

**Não existem hoje** e por isso não têm trava: envio de WhatsApp em massa (a importação em lote só traz histórico), sequência ou automação de WhatsApp, SMS e mensagem pelo Instagram. Uma fonte nova que inicie contato precisa chamar `contactBlock` antes de enviar.

**Fica como está:**

- Resposta digitada por uma pessoa dentro da janela de 24 h (a pessoa escreveu primeiro), e arquivo da negociação enviado pela Central, que também só vai dentro da janela: só a trava atual da prospecção (`whatsapp_no_opt_in`) e a janela, sem mudança.
- Ligação pelo celular do vendedor e e-mail fora do sistema: o sistema não controla; o selo avisa.
- Resumo de reunião ao franqueador (`meetings/routes.ts`): vai para um cliente, não para um lead.

## A Sofia

Quando alguém com "não me contate" ativo (WhatsApp ou todos, um SAIR, um prospect `nao_contatar` ou a regra da prospecção) escreve de novo, a Sofia **não responde**. A conversa vai para "espera um atendente" com o motivo `nao_me_contate`, e o dono da negociação (ou, sem dono, gerência e diretoria) recebe o aviso "Pediu para não ser contatado e escreveu de novo no WhatsApp. A Sofia não respondeu: veja a conversa e decida." Uma pessoa decide: responder dentro da janela, ou pedir à gerência que revogue. A palavra SAIR em si continua recebendo a confirmação de saída da Sofia, como antes.

## Quem grava

- **Botão "Não me contate"** na página da negociação: escolhe canais e motivo, confirma na própria tela. Precisa de `leads.write` na negociação. Grava as chaves do lead (id, telefone, e-mail, Instagram, CNPJ, `place_id`). Rotas: `GET` e `POST /leads/:id/contact-opt-outs` (`contact-opt-out-routes.ts`).
- **SAIR, PARAR, STOP…** no WhatsApp (`intake.ts`) e o "não quero mais mensagens" lido pela Sofia: gravam pelo telefone, canal WhatsApp, origem `whatsapp_palavra`, e continuam gravando `opt_out_at`.
- **Prospect marcado `nao_contatar`** (`prospecting/service.ts:updateProspect`): grava em todos os canais, pelo `place_id` e pelas chaves do lead ligado, se houver.

## Quem revoga

Só gerência e diretoria (`leads.assign` com escopo todos: Admin Master, Diretoria, Gerente comercial), com motivo: `POST /leads/:id/contact-opt-outs/revoke` revoga as linhas do cadastro daquele canal que alcançam a negociação, grava `lead.contact_opt_out_revoked` na auditoria e uma anotação na linha do tempo. O SAIR do WhatsApp (`opt_out_at`) não é apagado pela revogação (some quando a pessoa escreve de novo, como antes), e o prospect `nao_contatar` muda na Prospecção.

## Na tela

- Página da negociação: faixa "Não me contate" com canal, desde quando e origem de cada um; botões de registrar e revogar (`ContactOptOutStrip.tsx`).
- Conversa do WhatsApp: "Usar modelo" mostra o motivo no lugar do envio; escrever livre dentro da janela continua (`DealWhatsApp.contactBlock`).
- Ligações: "Ligar pelo WhatsApp" e "Pedir permissão" desabilitados com o motivo (`DealWhatsApp.callBlock`).
- Aba E-mail: envio desabilitado com o motivo (`LeadEmails.blocked`).
- Busca da Prospecção: selo "não me contate: canal, desde dd/mm/aaaa (origem)" no cartão da empresa, por `place_id` ou telefone.

## Testes

`contact-block.test.ts` (normalização, idempotência, canais, fontes antigas, regra da prospecção, revogação); `whatsapp.test.ts`, `central-contact-block.test.ts` (número de trabalho e conversa sem negociação), `calls.test.ts`, `lead-email.test.ts`, `automations.test.ts`, `sofia.test.ts`, `prospecting.test.ts`, `maps-prospecting.test.ts` (um por caminho); na web, `ContactOptOutStrip.test.tsx` e `LeadEmailTab.test.tsx`.
