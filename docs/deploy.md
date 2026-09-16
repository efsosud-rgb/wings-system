# Deploy (Coolify)

## Ambientes

| Ambiente | Branch    | Domínio                            | Estado                                              |
| -------- | --------- | ---------------------------------- | --------------------------------------------------- |
| Staging  | `develop` | https://staging.wingssystem.online | ativo                                               |
| Produção | `main`    | https://wingssystem.online         | ainda servido pelo container manual `wings-crm-web` |

Um push em `develop` dispara o deploy de staging pelo Coolify. O prefixo `/api`
é roteado pelo Traefik para a aplicação da API e **removido** antes de chegar ao
Fastify — por isso as rotas são registradas sem `/api` (o proxy do Vite faz o
mesmo em desenvolvimento).

## Recursos no Coolify

| Recurso                         | UUID                       | Observações                                                 |
| ------------------------------- | -------------------------- | ----------------------------------------------------------- |
| Projeto `Wings System`          | `tshq8o8gltyp3snhknwqiq56` | ambientes: production, staging                              |
| Banco `wings-system-db-staging` | `q5kvm2ygakmm34rjwwir4rhj` | postgres:17-alpine, sem porta pública, separado do n8n      |
| App `wings-api-staging`         | `39k6fbobdibfx96xz1p8gqkv` | `docker/api.Dockerfile`, porta 3000                         |
| App `wings-web-staging`         | `yxa9bjwbbekricwldlipvipg` | `docker/web.Dockerfile`, porta 80                           |
| Deploy key                      | `iajyod5szl1vjnyfhwgpsccg` | chave somente-leitura no GitHub (rotacionada em 2026-09-16) |

O container da API roda `db:migrate` e `db:seed` antes de servir tráfego.

## Segredos

Ficam nas variáveis de ambiente da aplicação no Coolify — nunca no repositório:
`DATABASE_URL`, `SESSION_SECRET`, `CPF_ENCRYPTION_KEY`, `CPF_INDEX_KEY`,
`NODE_ENV`, `API_PORT`. O Coolify cria automaticamente uma cópia de cada
variável para deploys de preview (mesmo valor).

> ⚠️ Faça backup de `CPF_ENCRYPTION_KEY` fora do servidor. Sem ela, os CPFs
> armazenados são irrecuperáveis. Copie o valor pela interface do Coolify.

## Backups do banco (staging)

Duas rotinas diárias no Coolify, sobre o banco `wings-system-db-staging`:

| Rotina        | UUID                       | Agendamento (UTC)        | Destino                                      | Retenção           |
| ------------- | -------------------------- | ------------------------ | -------------------------------------------- | ------------------ |
| Local         | `bsdnwcdritapetq1behm51it` | `0 3 * * *` (00:00 BRT)  | `/data/coolify/backups/databases/...` no VPS | 7 cópias / 7 dias  |
| Cloudflare R2 | `owzy1ppxwjra8ty1csrmic21` | `30 3 * * *` (00:30 BRT) | storage `r2-wings-backups`                   | 30 no R2, 2 locais |

As credenciais do R2 ficam em `/etc/wings-crm/r2-backup.env` (modo 600) e no
registro de storage do Coolify — nunca no repositório. O formato é `pg_dump`
custom (`.dmp`); restaure com `pg_restore`.

Retenção e execução manual não são expostas pela API do Coolify nesta versão
(4.3.18): use a interface, ou o próprio modelo via
`docker exec coolify php artisan tinker`.

## Pendências

1. **Produção** continua no container manual `wings-crm-web`; a migração para o
   Coolify será feita em etapa própria, com rollback documentado.
2. Apenas o `coolify-proxy` pode publicar as portas 80/443 do host.
