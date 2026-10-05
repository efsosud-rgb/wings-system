# CRM Vendas: regras de automação

Formato das "Regras de automação" do Bitrix24: por etapa do funil, o que acontece quando
uma negociação **entra** nela. Tela: `/crm-vendas/configuracoes/automacoes/:pipeline`
(`crm.manage`). API: `/crm/automations/*`.

## Ações

| Ação | O que faz | Serviço usado |
| --- | --- | --- |
| Criar tarefa | tarefa automática (`auto`) para o responsável ou uma pessoa, prazo em horas úteis (seg–sex 9h–18h) ou corridas | `createTask` |
| Mudar o responsável | para uma pessoa ou o próximo do rodízio do funil | `nextInRotation` + `changeLead` |
| Avisar alguém | aviso no painel (`crm_notifications`), texto da regra, sem dado pessoal | — |
| Iniciar sequência | agenda os passos (tarefa, e-mail ou aviso) com intervalo em horas | — |
| Enviar modelo de e-mail | grava no `crm_email_outbox` e na linha do tempo (`lead.email_sent`, só ids) | transporte de CRM |

Cada regra pode ter atraso (minutos, horas ou dias após a entrada).

## Quando dispara

- Só em mudança de etapa feita por **pessoa ou Sofia** (`source` `wings`/`sofia`). O espelho do
  RD e a importação não disparam (inundariam a fila).
- Os `crm_automation_runs` pendentes de uma etapa são **cancelados** quando a negociação sai
  dela ou é ganha/perdida. Uma entrada repetida não duplica (`dedupe_key`).
- O que está vencido roda na hora; o atrasado (e os passos de sequência) roda quando
  `POST /crm/automations/run` é chamado. **Falta agendar essa chamada** (tarefa agendada de 5 em
  5 minutos no Coolify, decisão do Eric).
- Um passo que falha fica `failed` e nunca é repetido sozinho; um processador interrompido
  deixa `running` que vira `failed (interrupted)` depois de 15 minutos.

## E-mail

`CRM_EMAIL_MODE`: `test` (padrão, grava e não envia nada) ou `smtp` (Workspace, o mesmo
`SMTP_*` das senhas). Variáveis dos modelos: `{{nome}}` (primeiro nome), `{{marca}}`,
`{{vendedor}}`, `{{etapa}}`; qualquer outra é recusada ao salvar. O texto fica no outbox
(a ficha do lead), nunca em log.

## Migração

`0066_crm_automations` (7 tabelas; renumerar no merge se outra entrar antes). `wings_ro` lê
regras, execuções e sequências; o outbox e os avisos ficam de fora (têm texto).
