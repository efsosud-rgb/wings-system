# 0004 — Mesma origem em todo ambiente e sessão guardada no servidor, sem JWT

- **Data:** 16/09/2026 (commit `65b724c5`, rotas sem o prefixo `/api` atrás do roteador)
- **Quem decidiu:** não registrado no repositório
- **Situação:** em vigor
- **Fonte:** `AGENTS.md`, seção 1 ("How the parts relate") e seção 2 ("Authentication and sessions"); `docs/auth.md`;
  `docs/deploy.md` (o prefixo `/api` é removido antes de chegar ao Fastify); `PRODUCT.md` ("Operating Context")
- **Onde conferir:** `apps/api/src/plugins/auth.ts`, `docker/web-nginx.conf`, `apps/web/vite.config.ts` (proxy de
  desenvolvimento)

## Contexto

A tela e a API precisam de login com cookie, expiração por inatividade e corte imediato do acesso quando alguém é
desligado ou muda de nível.

## Decisão

- Em todo ambiente, o Traefik manda `/api/*` para a API e o resto para a tela: mesma origem, sem CORS.
- Sessão no servidor: o cookie leva um token aleatório e o banco guarda só o SHA-256 dele. Nada de JWT.
- Senhas em Argon2id; ninguém define a senha de outra pessoa (convite com link de uso único).

## Motivo

Registrado no `AGENTS.md`: sem CORS e com cookie simples; e sessão no banco permite encerrar o acesso na hora
(`revokeAllSessions()` ao desligar, mudar o nível ou o e-mail de login).

## Consequências

- Rotas da API são registradas sem `/api`; o proxy do Vite faz o mesmo em desenvolvimento.
- Método inseguro com `Origin` de fora é recusado (CSRF), além do `SameSite=Lax`.
- As landing pages ficam em hosts próprios e chamam só as rotas públicas `/public/site-forms/:slug`.
