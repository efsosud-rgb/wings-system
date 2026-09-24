# Gestão → Projetos

O projeto de cada cliente: em que status está, em que etapa está e como anda
cada uma das oito etapas que a pasta do cliente no Drive tem
(`Clientes/<NN. Nome>/01…08`, ver `docs/drive.md`). Um quadro tipo Monday:
cliente por linha, etapas em colunas.

Três regras valem para tudo aqui:

- **Um projeto por cliente, nascido com o cliente.** Cadastrar o cliente abre
  o projeto Em Andamento, na etapa 01, com as oito etapas não iniciadas, na
  mesma transação. A migração `0032_client_projects` fez isso para os clientes
  que já existiam. A Wings Company não é cliente de si mesma e não tem projeto.
- **Quem mexe em quê é decidido em `@wings/shared` e conferido de novo pela
  API.** A tela só esconde o que a API disse que a pessoa não pode
  (`canManage`, `canEdit` por etapa).
- **Tudo fica registrado.** Cada mudança vai para o `audit_log`; cada mudança
  de status vai também para o histórico só-inclusão, com o motivo.

## Modelo de dados

- `client_projects` (um por cliente, `client_id` único): `status`
  (`em_andamento | parado | cancelado | finalizado`), `current_stage`
  (`01`…`08`), `updated_by`, `updated_at`.
- `client_project_stages` (oito por projeto, `project_id + slot` único):
  `progress` (`nao_iniciada | em_andamento | concluida | bloqueada`), `note`
  (obrigatória em bloqueada), `department` (copiado de `PROJECT_STAGES`; é ele
  que decide quem mexe), `started_at`, `completed_at`, `updated_by`,
  `updated_at`.
- `client_project_status_history` (só-inclusão): `from_status`, `to_status`,
  `reason`, `changed_by`, `changed_at`. A constraint
  `client_project_status_history_reason_check` exige motivo em Parado e
  Cancelado, seja quem for que grave. Nada aqui é alterado nem apagado pela
  aplicação.

Mudança de andamento de etapa não tem tabela de histórico: fica só na
auditoria (`project.stage_changed`, com etapa, valor anterior e novo). O motivo
e a observação ficam nas tabelas do projeto, nunca nos metadados da auditoria.

## Regras

- **Etapa atual** é escolhida explicitamente por quem tem status. Concluir a
  etapa atual leva o cliente à próxima etapa não concluída (auditado como
  `project.current_stage_changed` com `auto: true`); concluir outra etapa não
  move nada. Reabrir uma etapa concluída limpa a data de conclusão.
- **Finalizado e Cancelado congelam as etapas**: andamento e etapa atual
  respondem 409 `project_closed` até o projeto voltar a Em Andamento (ou
  Parado). A recusa de departamento (403 `stage_forbidden`) vem antes: outro
  departamento nunca fica sabendo mais do que "não é sua".
- Mudar para o status em que já está responde 409 `same_status`.
- **Cliente desativado** mantém o projeto como está e sai do quadro; o filtro
  "Mostrar clientes inativos" (`?inactive=true`) traz de volta.
  Administração → Clientes mostra todos.

## Permissões

| Perfil                                        | `projects.read` | `projects.manage` | Pode                                 |
| --------------------------------------------- | --------------- | ----------------- | ------------------------------------ |
| Admin Master, Diretoria, Processos e Projetos | all             | all               | status, etapa atual e qualquer etapa |
| Financeiro, Contábil/Tributário               | all             | sector            | andamento da etapa 04                |
| Jurídico                                      | all             | sector            | andamento da etapa 06                |
| Gerente Comercial e vendedores                | all             | sector            | andamento da etapa 07                |
| Marketing                                     | all             | sector            | andamento da etapa 08                |
| Logística, TI, RH / DP                        | all             | —                 | só ler o quadro                      |

`sector` aqui quer dizer "as etapas dos departamentos do perfil": a mesma
lista em que o perfil escreve no Drive (`DRIVE_ROLE_DEPARTMENTS`), aplicada
por `stageEditableBy` em `packages/shared/src/projects.ts`. 01–03 (`imersao`)
e 05 (`projetos`) são de Processos e Projetos, que tem `all`. A API confere
a permissão na policy central (`requirePermission`) e a etapa de novo dentro
da transação, com a linha do projeto travada.

## API

Uma só, para o quadro, a etiqueta no Drive, Administração → Clientes e, depois,
o Portal do Cliente:

| Rota                                      | Quem                       | Faz                                                             |
| ----------------------------------------- | -------------------------- | --------------------------------------------------------------- |
| `GET /projects?status=&inactive=true`     | `projects.read`            | o quadro: cliente, status, etapa atual e as oito etapas         |
| `GET /projects/:clientId`                 | `projects.read`            | um projeto com o histórico de status (mais novo primeiro)       |
| `PATCH /projects/:clientId/status`        | `projects.manage` em `all` | `{ status, reason? }`; motivo obrigatório em parado/cancelado   |
| `PATCH /projects/:clientId/current-stage` | `projects.manage` em `all` | `{ stage }`; 409 se fechado                                     |
| `PATCH /projects/:clientId/stages/:slot`  | `projects.manage`          | `{ progress, note? }`; 403 fora do departamento; 409 se fechado |

Cada resposta traz `canManage` e `canEdit` por etapa, calculados para quem
pediu. Schemas e enums em `packages/shared/src/projects.ts`.

## Telas

- **Gestão → Projetos** (`/gestao/projetos`): o quadro. Filtro por status,
  busca por nome, inativos sob demanda. Clicar no status abre a janela que
  exige motivo em Parado e Cancelado; a etapa atual é um select; clicar numa
  etapa (só nas que a pessoa pode) abre a janela de andamento, que exige
  observação em Bloqueada. Legenda: cinza não iniciada, azul em andamento,
  verde concluída, vermelho bloqueada; borda laranja na etapa atual.
- **Drive**: a pasta do cliente e as 01–08 mostram a etiqueta de status e a
  etapa atual; numa 01–08, também o andamento daquela etapa. Só leitura.
- **Administração → Clientes**: coluna "Projeto" com status e etapa atual; o
  status abre a mesma janela do quadro.

## Staging

A migração dá `GRANT SELECT` nas três tabelas a `wings_ro` quando o papel
existe (staging); em banco sem o papel (local, testes) o passo é pulado.

## Fora desta fase

Portal do Cliente; tarefas, subtarefas e prazos por etapa; comentários e
notificações; histórico de andamento de etapa (só auditoria); arrastar e
soltar; Entrega ligada à etapa; relatórios e indicadores de projeto; projetos
que não sejam de cliente.
