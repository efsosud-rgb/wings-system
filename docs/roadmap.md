# Administração → Roadmap

Relatório diário de progresso do Wings System para a diretoria (Umberto e
Thais), aprovado por Eric (Admin Master) antes de sair. Tela em
`/administracao/roadmap`, atrás de `roadmap.manage` (só Admin Master).

Duas regras valem para tudo aqui:

- **Ninguém fora do sistema recebe nada sem um clique de aprovação.** O
  rascunho das 17:30 vai só para Eric; o relatório final das 18:00 só sai
  depois de aprovado, e só se `ROADMAP_REPORT_SEND_ENABLED=true` — o mesmo
  padrão de `ADS_WRITES_ENABLED`, desligado por padrão em todo ambiente,
  produção incluída.
- **O que o agente de linguagem escreve nunca inclui um número que ele
  inventou.** Ele só transforma números já calculados (`scoring.ts`) em
  frases curtas em português; sem `OPENROUTER_API_KEY`, ou se a chamada
  falhar por qualquer motivo, um texto de modelo simples carrega os mesmos
  números sozinho.

## Modelo de dados

- `roadmap_modules`: um módulo da navegação (`packages/shared/src/navigation.ts`,
  nível "Módulo", não sub-módulo), com `key`, `label`, `position` e
  `is_coming_soon` (verdadeiro quando todos os seus sub-módulos ainda são
  "em breve"). Sempre sincronizado com `navigation.ts` pelo gerador — não
  existe módulo editado à mão.
- `roadmap_deliverables`: um entregável por sub-módulo de `navigation.ts`
  (`module_id`, `label`, `weight` P/M/G, `status`
  `pronto | em_andamento | pendente`, `completed_at`, `source`
  `auto_draft | manual`, `notes`). O gerador só escreve em cima de uma linha
  `auto_draft`; uma edição humana (pela tela) vira `manual` e o gerador nunca
  mais mexe nela.
- `roadmap_deliverable_changes`: só-inclusão, como o padrão de
  `employee.role_changed` no audit log e do histórico de status dos projetos
  (`docs/projetos.md`) — cada mudança de status/peso feita por uma pessoa vira
  uma linha nova (`deliverable_id`, `changed_by`, `previous`, `next` em JSON,
  `changed_at`), nunca uma atualização em cima da anterior. Mudanças que o
  gerador faz em uma linha `auto_draft` não passam por aqui: a auditoria é
  para decisão humana, e a maioria dos entregáveis nunca é editada à mão.
- `roadmap_report_runs`: um por dia útil (`report_date` única), com o
  `computed` (percentuais, velocidade, previsão — o retrato exato do momento
  em que o relatório foi composto), o `message_text` já pronto, e o ciclo de
  status `rascunho → aprovado → enviado` (ou `enviado_simulado`, ver abaixo).
- `roadmap_report_recipients`: `preview` (Eric, recebe o rascunho às 17:30) e
  `ceo` (Umberto e Thais, recebem o final às 18:00, só depois de aprovado).

A lista de módulos e pesos **não** entra no `db:seed` — é gerada pelo CLI
abaixo e depois ajustada à mão por Eric na tela.

## O gerador (primeira versão)

`apps/api/src/modules/roadmap/generator.ts` percorre os commits de `develop`
(onde todo o trabalho deste repositório pousa primeiro — `main` não precisa
ser lido) via `apps/api/src/lib/github-repo-history.ts`, um cliente REST do
GitHub mínimo, só leitura, no estilo de `lib/zapi.ts`.

Cada arquivo que um commit mexeu é ligado a um sub-módulo de `navigation.ts`
por três tabelas pequenas dentro do gerador:

- `apps/api/src/modules/<nome>` → o sub-módulo que aquele módulo da API serve;
- `apps/web/src/pages/<Componente>.tsx` → o sub-módulo que aquela tela
  renderiza (espelha o mapa `SCREENS` de `apps/web/src/router.tsx`);
- `docs/<tópico>/...` ou `docs/<tópico>.md` → o mesmo sub-módulo, quando o
  nome do tópico bate com um módulo da API (ou com um alias, para os poucos
  casos em que o nome da pasta de docs é diferente, como `integracoes` →
  `integrations`).

Nomes de pasta em inglês não batem literalmente com as rotas em português de
`navigation.ts`, por isso essas tabelas existem à mão — e precisam de uma
linha nova quando um módulo ou uma tela muda de lugar. `navigation.ts`
continua sendo a autoridade: é de lá que vêm o rótulo e o `coming_soon` de
cada sub-módulo.

Para cada sub-módulo com commits de verdade, o gerador soma as linhas
alteradas (`additions + deletions`) em todos os commits que tocaram seus
caminhos e marca o entregável `pronto`, com peso P (<100 linhas), M (<400) ou
G (o resto). **Data de conclusão**: o commit mais recente que tocou aquele
caminho — sem um merge de PR neste fluxo (tudo pousa direto em `develop`), é o
momento mais defensável para "quando isso ficou pronto", ao contrário do
primeiro commit, que dataria a entrega para quando ela **começou**. Um
sub-módulo `coming_soon` em `navigation.ts` vira entregável `pendente`, peso M
(sem commits para dar um sinal de tamanho melhor), sem data. Um sub-módulo
`ready` sem nenhum commit reconhecido pelas tabelas acima (uma lacuna do
mapeamento) ainda conta `pronto` — `status: 'ready'` já significa "tem tela e
backend" por definição de `navigation.ts`, e uma lacuna do gerador nunca deve
rebaixar isso — só fica sem peso melhor (M) e sem data (`null`).

Tudo que o gerador escreve carrega `source: 'auto_draft'`.

## Matemática (`scoring.ts`, sem banco, testada isoladamente)

- Peso: P=1, M=2, G=3.
- % de um módulo: `pronto` conta o peso inteiro, `em_andamento` conta metade,
  `pendente` conta zero, dividido pelo peso total do módulo. Sem nenhum
  entregável, a % é `null` (sem dado), nunca zero.
- % total: média dos % de cada módulo, ponderada pelo peso total de cada um.
- Velocidade: peso concluído por semana, nas últimas 4 semanas e desde o
  primeiro entregável concluído — a partir da data `completed_at` de cada
  entregável `pronto` (não da tabela de auditoria: a maioria dos entregáveis
  é `auto_draft` e nunca passa por ela, então reconstruir a linha do tempo a
  partir dela subcontaria; `completed_at`, seja escrito pelo gerador ou por
  uma pessoa, é a data de negócio autoritativa).
- Previsão: peso restante ÷ velocidade, nas três leituras que dá para tirar de
  só duas janelas observadas — otimista usa o ritmo mais rápido das duas,
  pessimista o mais lento, provável a média — nunca dividindo por uma
  velocidade zero: nesse caso o limite vira "indeterminado" (`null`), nunca um
  erro.
- "Escopo aumentou X% na semana": peso total de hoje comparado ao peso total
  de uma semana atrás, aproximado pelo `created_at` dos entregáveis (sem
  tabela de instantâneo nova).

## Os dois jobs (Coolify Scheduled Task, sem worker novo)

Mesmo padrão que `docs/ads/primeira-escrita.md` já descreve para a ingestão de
anúncios: um **Coolify Scheduled Task** chama um comando dentro do container
**já existente** (`wings-api` em produção, `wings-api-staging` em staging) —
nenhum worker novo, nenhum app novo no Coolify.

```
node dist/modules/roadmap/roadmap-cli.js --generate  # a qualquer hora, idempotente
node dist/modules/roadmap/roadmap-cli.js --preview   # 17:30 horário de Brasília
node dist/modules/roadmap/roadmap-cli.js --send      # 18:00 horário de Brasília
```

- `--generate`: roda o gerador de commits. Sem `GITHUB_ROADMAP_TOKEN` e
  `GITHUB_ROADMAP_REPO` configurados, falha alto e claro — nunca escreve um
  roadmap vazio ou errado silenciosamente.
- `--preview`: pula em fim de semana (calendário de `America/Sao_Paulo`),
  calcula o retrato de hoje, grava um `roadmap_report_runs` (`rascunho`) e
  manda um WhatsApp aos destinatários `preview` ativos com o link
  `${APP_BASE_URL}/administracao/roadmap/relatorios/<id>`.
- `--send`: procura o relatório de hoje. Se não estiver `aprovado`, registra e
  sai — **nunca manda um relatório sem aprovação**. Se estiver aprovado,
  manda aos destinatários `ceo` ativos só quando `ROADMAP_REPORT_SEND_ENABLED`
  é explicitamente `true`, e marca `enviado`; com a flag desligada, marca
  `enviado_simulado` (o texto já composto fica salvo) e registra que nada foi
  enviado de verdade.

**Fuso**: `17:30` e `18:00` acima são horário de Brasília
(`America/Sao_Paulo`), mas o agendamento do Coolify Scheduled Task é em
**UTC** — quem configurar a tarefa precisa converter (BRT é UTC−3, sem
horário de verão desde 2019): `17:30` BRT = `20:30` UTC, `18:00` BRT =
`21:00` UTC.

## Variáveis de ambiente novas

| Variável                      | Para quê                                                                                          | Quem configura                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `GITHUB_ROADMAP_TOKEN`         | Lê os commits e arquivos alterados no GitHub para o gerador (`--generate`).                         | Eric — um PAT *fine-grained*, **só leitura**, com escopo **Contents + Metadata neste repositório apenas** (nunca um token clássico de escopo amplo). |
| `GITHUB_ROADMAP_REPO`          | `owner/repo` do repositório a ler.                                                                   | Eric                                     |
| `ROADMAP_REPORT_SEND_ENABLED`  | Liga o envio de verdade do relatório final (`--send`) para Umberto e Thais. **Desligada por padrão em todo ambiente**, produção incluída — mesmo padrão de `ADS_WRITES_ENABLED`. | Eric, só quando quiser que o envio real comece |

Reaproveitados, sem variável nova: `ZAPI_INSTANCE_ID` / `ZAPI_INSTANCE_TOKEN` /
`ZAPI_CLIENT_TOKEN` (o mesmo WhatsApp das aprovações de tráfego pago) e
`OPENROUTER_API_KEY` (o mesmo canal do agente de tráfego, modelo Haiku 4.5
fixo para este job — barato, e a lista de modelos permitidos já inclui só
Sonnet 5 e Haiku 4.5).

## Permissão

`roadmap.manage`, concedida só a `admin_master` (escopo `all`). A tela só
esconde o que a API já recusaria; a autoridade é a API.
