# Prazos do CRM em horas úteis

Os prazos do CRM contados em horas úteis só andam **de segunda a sexta, das 9h às 18h (horário de
São Paulo, o mesmo do Rio)**, e **não andam nos feriados nacionais, do estado do RJ e da cidade do
Rio de Janeiro** (Eric, 05/10/2026 para o horário; 31/10/2026 para os feriados).

## O que segue essa regra

| Prazo ou decisão                                                                  | Onde                                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Tarefa "Primeiro contato com o lead" (1 hora útil, `CRM_FIRST_CONTACT_SLA_HOURS`) | `ensureFirstContactTask` em `apps/api/src/modules/leads/crm.ts` |
| Tarefa de retorno quando o lead preenche o formulário de novo                     | `ensureReturnTask` em `crm.ts`                                  |
| Tarefa criada por automação com prazo em horas úteis                              | `createTaskAction` em `automations.ts`                          |
| Aviso aos gestores no fim do dia útil (1º contato sem registro)                   | `firstContactRows` em `crm-alerts.ts` (`endOfBusinessDay`)      |
| E-mail do 1º contato atrasado só em horário útil                                  | `sendPendingNoticeMails` em `crm-notice-mail.ts`                |
| Texto "fora do horário" da Sofia na transferência                                 | `withHours` em `apps/api/src/modules/sofia/engine.ts`           |

Prazos em horas **corridas** (automação com "horas corridas") não mudam.

Exemplos (com Finados em 02/11/2026, uma segunda-feira):

- Lead de sábado 31/10/2026 às 10h: vence **terça 03/11 às 10h**.
- Lead de sexta 30/10 às 17h30: vence terça 03/11 às 9h30.
- Lead de quinta 19/11/2026 às 17h30 (sexta 20/11 é Consciência Negra): vence segunda 23/11 às 9h30.

## De onde vêm os feriados

Da tabela `holidays` do Ponto (`day`, `name`, `scope` = `national`, `state` ou `city`). Toda linha
conta: a tabela não diz qual estado ou cidade, e é o calendário da própria Wings (estado do RJ e
cidade do Rio). O cálculo em si fica em `packages/shared/src/crm.ts` e recebe os dias como um
conjunto (`HolidaySet`), sem consultar o banco; a API lê a tabela uma vez por cálculo, por passada
ou por turno da Sofia (`loadHolidays` em `apps/api/src/lib/holidays.ts`), nunca uma vez por hora
somada. O argumento é obrigatório: quem chama o cálculo não pode esquecer os feriados.

A migração `0110_crm_holidays_rj_2026_2027.sql` carregou 2026 e 2027. Não sobrescreve um dia que
já estava na tabela. **Para 2028 em diante, e para um feriado decretado de última hora, é preciso
uma migração nova**: sem a linha, o dia conta como dia útil.

| Dia (2026 / 2027)                               | Esfera    | Fonte oficial                                                                                  |
| ----------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| 01/01, 21/04, 01/05, 07/09, 02/11, 15/11, 25/12 | nacional  | Lei 662/1949, art. 1º, com a redação da Lei 10.607/2002                                        |
| 12/10                                           | nacional  | Lei 6.802/1980                                                                                 |
| 20/11                                           | nacional  | Lei 14.759/2023 (também Lei estadual RJ 4.007/2002 e Lei municipal do Rio 5.146/2010, art. 8º) |
| Paixão de Cristo: 03/04/2026, 26/03/2027        | nacional  | Lei 9.093/1995, art. 2º; Portaria MGI 11.460/2025 classifica como feriado nacional             |
| Terça de Carnaval: 17/02/2026, 09/02/2027       | estadual  | Lei estadual RJ 5.243/2008                                                                     |
| 23/04 (São Jorge)                               | estadual  | Lei estadual RJ 5.198/2008                                                                     |
| Corpus Christi: 04/06/2026, 27/05/2027          | estadual  | Lei estadual RJ 11.002/2025 (60 dias depois da Páscoa)                                         |
| 20/01 (São Sebastião)                           | municipal | Lei municipal do Rio 5.146/2010, art. 8º, I                                                    |

**Ficam de fora (ponto facultativo, não feriado):** segunda de Carnaval, Quarta-feira de Cinzas
(no RJ é feriado só para bancários, Lei estadual 8.217/2018), os pontos facultativos da portaria
federal (por exemplo, 24/12 e 31/12 à tarde) e os do decreto do município do Rio.

Dúvidas registradas (decisão do Eric pendente):

- Paixão de Cristo: nenhuma lei federal a nomeia, e não achamos lei municipal do Rio que a declare.
  Entrou como nacional pela Lei 9.093/1995 e pela portaria federal, como todo calendário oficial trata.
- Terça de Carnaval: é feriado estadual por lei (5.243/2008), por isso entrou. A segunda e a quarta, não.
- Corpus Christi: feriado estadual novo (lei de 22/10/2025). Contamos como 60 dias depois da Páscoa.
- São Sebastião (20/01): a lei municipal foi lida só em cópia (LegisWeb); o site oficial da Câmara
  do Rio não abriu.
