# 0003 — Coolify no servidor da Wings, sem Kubernetes

- **Data:** 16/09/2026 (staging no Coolify, commit `b5afdb9a`); 31/10/2026 (atualização automática do Coolify desligada)
- **Quem decidiu:** não registrado para a escolha do Coolify; Eric para a regra de atualização de 31/10
- **Situação:** em vigor
- **Fonte:** `docs/deploy.md`; `AGENTS.md` (tabela de ambientes; seção 3, "Production, deploys and the shared checkout");
  `/opt/hermes/entrada/decisoes-2026-10-30.md` (registros de 31/10, 12:45, 13:15 e 13:23 UTC). "Sem Kubernetes": pedido
  da tarefa adr01 de 03/11; nenhum registro do Eric com essa palavra foi achado (ver "Consequências")
- **Onde conferir:** `docker/*.Dockerfile`, `docs/deploy.md`, `.claude/hooks/guard-production.sh`

## Contexto

O sistema roda num servidor (VPS) da própria Wings, que também tem o n8n e outros sites. É preciso subir quatro
aplicações (API, tela, landing pages e worker), dois ambientes e os bancos, com backup.

## Decisão

- Cada aplicação vira uma imagem Docker (`docker/api.Dockerfile`, `web.Dockerfile`, `landing.Dockerfile`,
  `worker.Dockerfile`) gerenciada pelo Coolify no servidor da Wings. Nada de Kubernetes nem outro orquestrador.
- O Traefik do Coolify (`coolify-proxy`) é o único que publica as portas 80 e 443 do servidor.
- O deploy é disparado pela API do Coolify com `wings-deploy staging` ou `wings-deploy production`; um deploy por vez.
- Atualização do Coolify só marcada com o Eric, com backup e conferência; a atualização automática fica desligada (31/10).

## Motivo

A escolha do Coolify não tem motivo registrado. A atualização automática foi desligada porque rodaria às 21h, junto da
rodada dos agentes, e mexe no painel que gerencia a produção (31/10, 13:15 UTC).

## Consequências

- Segredos ficam nas variáveis do Coolify (ver [0014](0014-segredos-so-no-coolify.md)).
- As tarefas agendadas de hoje (ingestão de anúncios e reconciliação) usam a tarefa agendada do Coolify
  (`docs/deploy.md`, `docs/roadmap.md`), sem serviço novo.
- Um contêiner que publique 80 ou 443 por conta própria já derrubou todos os sites do servidor uma vez.
- Divergência conhecida: `docs/deploy.md` diz que um push em `develop` dispara o deploy do staging e que a produção ainda
  roda num contêiner manual; o `AGENTS.md`, mais novo, diz que o repositório não tem webhook e que o deploy é sempre pelo
  `wings-deploy`. Vale o `AGENTS.md` até o `docs/deploy.md` ser corrigido.
- "Sem Kubernetes" está aqui como o que o sistema é hoje; adotar um orquestrador exige decisão nova do Eric.
