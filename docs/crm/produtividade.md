# Produtividade (Painel de Vendas)

Aba "Produtividade" do Painel de Vendas (`/dashboard/vendas?aba=produtividade` e, para os vendedores,
`/crm-vendas/painel-de-vendas?aba=produtividade`). Mede **por resultado**, com o que o CRM já registra: nada de
tempo logado, ponto, mouse, teclado, tela ou câmera (os colaboradores são PJ). Pedido do Eric de 24/10/2026,
confirmado em 26/10.

Os números vêm do modelo dimensional (`dw`, [../bi/README.md](../bi/README.md)): a API recarrega o modelo a partir das
tabelas do CRM 20 segundos depois de subir e a cada 15 minutos (`apps/api/src/modules/leads/productivity.ts`), e a aba
mostra "atualizado em" com a hora da última carga. Antes da primeira carga a aba mostra "—" e o motivo, nunca zeros.

## Quem vê o quê

Permissão `productivity.read` (`packages/shared/src/rbac/permissions.ts`), decidida na API pessoa a pessoa:

| Nível                    | Vê                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Vendedor                 | só a própria linha e a média da equipe (as pessoas do seu setor, sem nomes nem linhas) |
| Gerente Comercial        | as pessoas do seu setor, uma linha cada                                                |
| Diretoria e Admin Master | todo mundo que pode ter lead (vendedores, Gerente Comercial, Diretoria)                |
| Outros níveis            | 403                                                                                    |

"Equipe do gerente" é o setor dele (`employees.sector_id`): o sistema não tem outro vínculo de equipe. O bloqueio da
Diretoria sobre o setor de TI vale aqui como em todo lugar.

Filtros: período (os mesmos do painel: mês atual, 7, 30 e 90 dias, trimestre, ano, personalizado), funil (Expansão,
Formatação, Consultoria ou todos) e pessoa (só para quem vê mais de uma). Ficam no endereço, como os outros filtros do
painel.

## O que cada número responde

Tudo é contado no período escolhido, para a pessoa da linha. "Média da equipe" divide os totais da equipe pelo número
de pessoas dela; taxas e medianas da equipe são da equipe junta, não a média das médias.

| Coluna                       | Responde                                                                                                                                                                                                                                                                  | De onde vem                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leads recebidos              | Quantas negociações entraram no período com essa pessoa como dona? É a mesma contagem da lista de Negociações filtrada por "Entrou em".                                                                                                                                   | `fato_negociacao.criada_sk` (o dia de `entered_at`) e `vendedor_sk` (o dono atual).                                                                                                                                                                                                |
| 1º contato em até 1 h útil   | De quantos leads a pessoa fez o primeiro contato dentro de uma hora útil depois de recebê-lo? Mostra a porcentagem e, entre parênteses, "no prazo / decididos". Um lead ainda dentro da hora, sem tarefa de primeiro contato, ou fechado sem contato, não entra na conta. | A regra do contador "1º contato atrasado" do CRM: o relógio começa quando o lead ganha dono (tarefa `first_contact`, prazo = 1 hora útil); o contato é o que vier primeiro entre a tarefa concluída pela pessoa (não a fechada junto com o negócio) e a saída da etapa de entrada. |
| Mediana até o 1º contato     | Em quantos minutos úteis, no meio da distribuição, a pessoa faz o primeiro contato?                                                                                                                                                                                       | `dw.minutos_uteis` entre o lead ganhar dono e o contato: segunda a sexta, 9h às 18h de São Paulo, sem feriados até o calendário do Jurídico. Sexta 17h50 → segunda 9h50 = 60 minutos.                                                                                              |
| Ligações, Mensagens, E-mails | Quantas atividades de cada tipo a pessoa registrou?                                                                                                                                                                                                                       | `lead_activities` (ligação), `wa_messages` de saída com autor funcionário (mensagem), `crm_email_outbox` enviados por uma pessoa (e-mail; os de automação não contam).                                                                                                             |
| Reuniões agendadas           | Quantas reuniões a pessoa marcou?                                                                                                                                                                                                                                         | `crm_meetings` por quem marcou (`owner_employee_id`), menos as canceladas.                                                                                                                                                                                                         |
| Reuniões realizadas          | Quantas reuniões aconteceram?                                                                                                                                                                                                                                             | `crm_meetings` em andamento ou encerradas, mais as reuniões registradas à mão em `lead_activities`.                                                                                                                                                                                |
| Notas, Tarefas concluídas    | Quantas notas a pessoa escreveu e quantas tarefas concluiu?                                                                                                                                                                                                               | `lead_notes` e `lead_tasks` concluídas pela pessoa (as fechadas junto com o negócio não contam).                                                                                                                                                                                   |
| Avanços de etapa             | Quantas vezes a pessoa moveu uma negociação para uma etapa mais à frente do mesmo funil? Conta para **quem moveu**, não para o dono.                                                                                                                                      | `fato_movimentacao_etapa` (`lead_stage_history`), com `avanco = true`. Movimentos de automação, Sofia, triagem ou RD não têm pessoa.                                                                                                                                               |
| Ganhos, Perdas               | Quantas negociações da pessoa foram ganhas ou perdidas no período (pela data do fechamento)?                                                                                                                                                                              | `fato_negociacao.ganha_sk` e `perdida_sk`. Bate com o Painel de Vendas.                                                                                                                                                                                                            |
| Resposta no WhatsApp         | Em quantos minutos úteis, no meio da distribuição, a pessoa responde a uma mensagem do lead pelo WhatsApp do sistema?                                                                                                                                                     | `fato_atividade.minutos_uteis_resposta`: da primeira mensagem do lead ainda sem resposta até a resposta da pessoa. **Enquanto o número oficial não estiver no ar** (`whatsapp_settings.official_number_live`), mostra "—" com o motivo: os vendedores respondem pelo celular.      |
| Conversão por etapa          | Dos leads recebidos no período (no funil escolhido), quantos chegaram a cada etapa, e que porcentagem isso é? Calculado na consulta, nunca guardado.                                                                                                                      | Etapa atual da negociação e o maior destino em `fato_movimentacao_etapa`, contra as etapas do funil (`dim_etapa`).                                                                                                                                                                 |
| Perdas por motivo            | Por que as negociações do período foram perdidas?                                                                                                                                                                                                                         | O motivo fica no CRM (texto livre, pode citar uma pessoa): a consulta lê `leads.lost_reason` pelo id da negociação, agrupado. O DW não guarda o texto.                                                                                                                             |

### Ainda sem dado (mostra "—" e o motivo)

- **Fichas e COF enviadas:** o CRM não registra o envio de nenhuma das duas (não há etapa, atividade nem evento com
  esse nome). Quando houver, `cof_enviada_sk` em `fato_negociacao` já espera o marco.
- **Tarefas do Quadro de Projetos no prazo:** o módulo Projetos tem etapas fixas sem prazo nem responsável
  (`client_project_stages`), então não dá para medir "no prazo".
- **Resposta no WhatsApp:** só quando o número oficial estiver no ar e os vendedores responderem pelo sistema; as
  conversas importadas do celular não têm quem respondeu.

## Regras que valem

- Só ids no DW: nome, telefone e e-mail ficam no CRM (`dim_usuario.nome` é nulo; o nome da linha vem de `employees`
  na consulta). O motivo de perda também fica no CRM.
- `tenant_sk` em todo fato, com RLS pela função `dw.pode_ver_tenant` (provada com um papel comum em `bi-dw.test.ts`);
  a consulta da API filtra o tenant da Wings de forma explícita, porque o usuário da API é dono das tabelas.
- Taxas e medianas calculadas na consulta; `fonte` e `carregado_em` em toda linha.
- Nenhum zero no lugar de "não sei": sem carga, sem prazo decidido, sem contato, sem mensagem, a célula mostra "—" com o
  motivo no título.

## Testes

- `apps/api/src/db/bi-dw.test.ts`: DDL num Postgres real (19 tabelas), RLS nos fatos novos com um papel comum,
  `dw.minutos_uteis` (sexta 17h50 → segunda 9h50 = 60; mesmo dia; fim de semana = 0; invertido = nulo).
- `apps/api/src/modules/leads/productivity.test.ts`: carga e recarga sem duplicar, nenhum dado pessoal no `dw`, os
  totais do mês contra a lista de Negociações e o Painel de Vendas, o caso de hora útil gravado no snapshot, a visão de
  cada nível (vendedor, gerente, Diretoria, Admin, outro nível 403, anônimo 401).
- `apps/web/src/pages/crm/ProductivityTab.test.tsx`: a aba pelo endereço, a linha própria e a média da equipe, os "—"
  com motivo, o filtro de pessoa e as etapas do funil.

## Decisões tomadas em 26/10 (inverta se discordar)

1. "Equipe do gerente" = o setor dele.
2. "Leads recebidos" conta por "Entrou em" (`entered_at`), como a lista de Negociações; o Painel de Vendas conta por
   `created_at`, e os dois só diferem nos negócios importados.
3. Avanço de etapa é creditado a quem moveu.
4. `fato_funil_diario` e `dim_canal` não são carregados: nenhuma medida pedida precisa deles.
5. O motivo de perda não entra em `dim_motivo_perda` (texto livre com risco de nome de pessoa); é lido do CRM na
   consulta.
6. A Diretoria aparece como linha porque pode ter lead (Eric, 05/10: "Thais fica Diretoria e trabalha Formatação").
