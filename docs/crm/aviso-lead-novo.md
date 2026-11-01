# Aviso de lead novo: pop-up, sino e e-mail

Ordem do Eric, 13/10/2026. Quando um lead novo cai para um vendedor, ele é avisado de três jeitos, até
a troca do número para a API oficial do WhatsApp (o aviso por WhatsApp só entra depois dela):

| Aviso  | Onde                                                             | Quem recebe                         |
| ------ | ---------------------------------------------------------------- | ----------------------------------- |
| Pop-up | qualquer página do sistema, com som curto                        | só o **dono** do lead               |
| Sino   | `Topbar`, avisos não lidos                                       | o dono (e quem mais o aviso nomear) |
| E-mail | `CRM_NOTICE_EMAIL_ENABLED=true` (`docs/crm/avisos-por-email.md`) | só o **dono** do lead               |

## Pop-up

- `GET /crm/notifications/new-leads` (`leads.read`, `newLeadPopupsOf` em `crm-alerts.ts`): os avisos
  `new_lead` **não lidos** de quem pergunta, cujo lead ainda é dele, está aberto e na etapa de entrada
  ("Sem contato" / "Novo Contato"). Devolve `NewLeadPopups` (`packages/shared/src/crm.ts`): `leads`, só os
  que chegaram nas **últimas 2 horas** (`POPUP_RECENT_MS`), cada um um `NewLeadPopup` com **primeiro nome**,
  funil, origem (`originOf`, a mesma do e-mail) e o prazo do 1º contato; e `earlierCount`, quantos mais antigos
  ainda esperam o primeiro contato. Nada mais da pessoa. Entrar no sistema depois de uma noite ou de um fim de
  semana não empilha pop-up de ontem: os de antes viram **uma linha**, "N leads chegaram antes e ainda esperam o
  primeiro contato" (Depois: some pelo resto do dia e volta só se juntar mais; Ver avisos: abre o sino).
  Gerente, Diretoria e o dono antigo de um lead repassado recebem lista vazia; lead sem dono só gera o aviso
  `lead_unassigned` no sino.
- A tela (`NewLeadAlerts.tsx`, montada no `AppShell`) pergunta a cada 15 s, também com a aba em segundo plano,
  sempre **passiva** (`api.poll`): não conta como atividade e não segura a sessão. Quatro cartões por vez, o
  resto numa linha "+ N leads novos". **Abrir ficha** marca o aviso como lido e abre a negociação; **Depois**
  esconde neste navegador (`localStorage`) e deixa o aviso não lido no sino.
- Som e notificação do navegador só para lead que chega com a aba aberta (a primeira resposta de uma página
  recém-carregada aparece sem som). A notificação do sistema sai quando a página está longe (aba escondida ou
  outra janela em foco) e a pessoa permitiu; o pedido de permissão é um botão do próprio pop-up.
- O sino (`useNotifications`) passou a ser passivo: uma aba aberta e parada deixa a sessão vencer em 30 minutos.

## E-mail: o que a chave liga

Ligar `CRM_NOTICE_EMAIL_ENABLED` não manda e-mail de lead que já existe:

- Com a chave desligada, cada passada marca o `pending` como `skipped: disabled`; nada fica guardado.
- Um aviso `new_lead` com mais de **6 horas** é pulado (`too_old`), mesmo `pending`.
- O e-mail vai para `recipient_employee_id` e só se o lead ainda é dele (`not_owner` pula o resto).
- O aviso de 1º contato atrasado só nasce para lead que passa do prazo **depois** de ligar e ainda não foi
  avisado; os que já têm aviso (o antigo `first_contact_overdue:…` ou o novo) não voltam. Um lead atrasado
  que **troca de dono** gera o aviso para o novo dono.

## Lead que preenche o formulário de novo

Decisão do Eric, 21/10/2026. Quando o formulário do site (`POST /public/site-forms/<slug>`, hoje "Fale com a Wings")
cai num lead que **já existe** (mesmo telefone, depois mesmo e-mail: `lead.merged` na auditoria), o lead não muda de
dono, de funil nem de etapa, e:

- **Linha do tempo:** a chegada vira a linha "Preencheu o formulário do site de novo" (o mesmo evento
  `lead.received.site_form`, com `matched: existing`), e o `detail.submitted` guarda o que **este** envio disse: a
  resposta de "O que você procura?", empresa, Instagram, site e as UTMs da visita. As colunas do lead ficam como
  estavam (a primeira resposta, o primeiro toque); só uma lacuna vazia é preenchida, como sempre foi (`fillGaps`).
- **Tarefa de retorno** (`ensureReturnTask`, `crm.ts`): "Retornar: o lead preencheu o formulário do site de novo",
  tipo follow-up, automática, para o **dono**, prazo de 1 hora útil (o mesmo `CRM_FIRST_CONTACT_SLA_HOURS` do
  primeiro contato). **No máximo uma por lead a cada 24 h** (`RETURN_LIMIT_MS`, decisão do Eric de 29/10/2026), contadas
  de quando a anterior foi criada, **concluída ou não**: enquanto ela estiver aberta, um novo envio não cria outra (se o
  lead trocou de dono, a tarefa passa para ele); concluída a tarefa, um envio dentro das 24 h também não cria outra;
  passadas as 24 h, o próximo envio cria uma nova (se a anterior foi concluída). Conta nos contadores e nos atrasos como
  qualquer follow-up (`task_overdue`), não como primeiro contato.
- **Aviso no sino** (`announceLeadReturned`, `crm-alerts.ts`), tipo `lead_returned`: ao dono, "O lead preencheu o
  formulário do site de novo. A resposta nova está no histórico. Retorno até dd/mm hh:mm (1 hora útil)."; sem dono,
  "Um lead sem dono preencheu o formulário do site de novo. Atribua alguém." para Admin Master, Diretoria e gerente
  comercial (os mesmos do `lead_unassigned`: o rodízio não é gasto e ninguém vira dono, porque um vendedor só vê os
  leads dele e um aviso de lead alheio não abriria nada). **Só o sino:** sem pop-up (ele é do `new_lead`) e **sem
  e-mail** (`email_state = none`; nenhum envio novo foi criado).
- **Janela de 10 minutos:** o mesmo formulário enviado **duas vezes seguidas** (clique duplo no "Enviar", nova tentativa
  em rede lenta) não é "voltou": um lead com menos de **10 minutos** de vida (`SITE_FORM_RETURN_MIN_AGE_MS`, `service.ts`,
  decidido dentro da transação do `upsertLead`) que chega de novo pelo formulário só ganha a linha do tempo, sem
  tarefa nem aviso.
- **Limite de 24 h (Eric, 29/10/2026): "no máximo 1 aviso e 1 tarefa por lead a cada 24 h".** Decidido em
  `registerLeadReturn` (`lead-return.ts`), na **mesma transação** que guarda a resposta, com trava consultiva por lead
  (envios ao mesmo tempo não passam juntos). O **aviso** é um por lead (não por pessoa) a cada 24 h
  (`announceLeadReturned` olha o último `lead_returned` do lead; a `dedupe_key`
  `lead_returned:<lead>:<pessoa>:<AAAA-MM-DD>` continua como rede de segurança). A **resposta nova é guardada sempre**
  na linha do tempo, dentro ou fora das 24 h. As 24 h correm da criação do último aviso/da última tarefa: 23 h 59 min
  depois ainda segura, 24 h e um minuto depois libera. Se o dono muda dentro das 24 h, o novo dono só é avisado quando
  a janela passar. O **eco do RD** (o webhook do RD Marketing repete cada envio do formulário de 44 s a alguns minutos
  depois, como `lead.received.rd_station` no mesmo lead) não gera aviso, tarefa nem e-mail: os dois valem **só** para a
  fonte `site_form`. O eco também **não enfileira a pesquisa paga** (`enrich_lead`): uma chegada do RD num lead com
  chegada `site_form` na última hora (`RD_ECHO_WINDOW_MS`, lido dentro da mesma transação) pula a pesquisa; outra
  conversão do RD, mais tarde, pesquisa como sempre (lead nunca pesquisado ou com pesquisa falhada), veja
  [../leads/pesquisa-da-empresa.md](../leads/pesquisa-da-empresa.md).
- **Lead suspeito de robô** ([../leads/suspeitos.md](../leads/suspeitos.md)): um lead com a marca (`suspect_at`, sem
  "Não é robô") que preenche o formulário de novo só ganha a linha do tempo: **nem tarefa nem aviso**, para uma rajada de
  gente inventada não virar tarefa de vendedor. A regra de rajada em si (4 envios em 3 minutos na mesma página)
  continua olhando os leads que **nascem**; um reenvio não conta nela. Quem tira a marca ("Não é robô") religa o
  aviso e a tarefa no envio seguinte.
- **"Não me contate"** ([nao-me-contate.md](nao-me-contate.md)): a tarefa de retorno é uma ordem de contato. Se a
  pessoa pediu para não ser contatada em **todos** os canais (WhatsApp, telefone, e-mail e Instagram; conferido por
  todas as chaves do lead e pelo telefone e e-mail digitados desta vez, `contactBlock`), **não nasce tarefa**; o dono
  (ou, sem dono, gerência e diretoria) ainda recebe **um** aviso por 24 h, que diz que ela "pediu para não ser
  contatada" e que nenhuma tarefa foi criada. Bloqueio de só alguns canais não impede a tarefa: o vendedor pode
  tentar os que sobraram.
- **Lead encerrado (venda ou perda):** hoje o envio cai nele mesmo, com a tarefa e o aviso acima, e a etapa não
  muda (ordem do Eric: só descrever). Proposta a decidir: abrir uma negociação nova ao lado da encerrada, como o Meta
  Lead Ads já faz (`reopenClosed`), em vez de reabrir a antiga.
- Fora desta decisão (o código de hoje): Expansão e Consultoria escolhidas no formulário continuam caindo no rodízio
  de **Formatação** (a regra `fale-com-a-wings` não tem marca e o seed não dá funil próprio a essas opções); e
  `CRM_EMAIL_MODE` continua com o padrão `test` (só registra), sem regra `send_email` cadastrada.

Teste: `apps/api/src/modules/leads/site-form-again.test.ts` (clique duplo, dono dez minutos depois, eco do RD, 24 h
depois, dois envios ao mesmo tempo, sem dono, conversão do RD com pesquisa falhada e o grupo "the 24 h limit": 23 h 59
min segura e 24 h libera, resposta guardada sempre, cinco envios juntos, lead suspeito, "não me contate" por e-mail do
lead, por e-mail digitado e em um canal só); linha do tempo em
`apps/web/src/pages/crm/DealTabs.test.tsx`.

## Teste de ponta a ponta no staging

`apps/api/src/scripts/notice-test-lead.ts`, dentro do contêiner da API (recusa fora de staging/local):

```
node dist/scripts/notice-test-lead.js estado --owner-email=<e-mail do dono>
node dist/scripts/notice-test-lead.js criar  --owner-email=<e-mail do dono>   # lead de teste, dono escolhido, sem rodízio
node dist/scripts/notice-test-lead.js marcar --lead=<id>                      # nome de teste, encerrado como perda "Teste do aviso"
```

Testes: `apps/api/src/modules/leads/new-lead-popup.test.ts`, `apps/web/src/components/NewLeadAlerts.test.tsx`.

## Funil que a Negociações abre

Sem `?funil=` no endereço, a tela abre no funil que o nível da pessoa vende (`defaultPipelineOfRole`,
`packages/shared/src/leads.ts`): Vendedor Formatação em **Formatação**; os demais níveis seguem em **Expansão**,
como sempre. Antes todo mundo abria em Expansão, e uma vendedora de Formatação via "0 negócios" mesmo com
leads dela no outro funil. O seletor de funil continua valendo, e o endereço com `?funil=` manda.
