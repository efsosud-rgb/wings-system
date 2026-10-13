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
  ("Sem contato" / "Novo Contato"), com até 3 dias. Devolve `NewLeadPopup` (`packages/shared/src/crm.ts`):
  **primeiro nome**, funil, origem (`originOf`, a mesma do e-mail) e o prazo do 1º contato. Nada mais da pessoa.
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

## Teste de ponta a ponta no staging

`apps/api/src/scripts/notice-test-lead.ts`, dentro do contêiner da API (recusa fora de staging/local):

```
node dist/scripts/notice-test-lead.js estado --owner-email=<e-mail do dono>
node dist/scripts/notice-test-lead.js criar  --owner-email=<e-mail do dono>   # lead de teste, dono escolhido, sem rodízio
node dist/scripts/notice-test-lead.js marcar --lead=<id>                      # nome de teste, encerrado como perda "Teste do aviso"
```

Testes: `apps/api/src/modules/leads/new-lead-popup.test.ts`, `apps/web/src/components/NewLeadAlerts.test.tsx`.
