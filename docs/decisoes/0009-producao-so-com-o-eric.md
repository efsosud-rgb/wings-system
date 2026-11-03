# 0009 — Produção só com o Eric, que digita PRODUCAO

- **Data:** 29/10/2026 (política dos agentes, 14:48); 30/10/2026 (como cada etapa da produção sobe e volta atrás)
- **Quem decidiu:** Eric
- **Situação:** em vigor
- **Fonte:** `/opt/agentes/politica.md` ("Só com o Eric"); `AGENTS.md`, seção 3 ("Production only with PRODUCAO typed by
  Eric"); `/opt/hermes/entrada/decisoes-2026-10-30.md` (manhã: cópia do banco, voltar atrás, pausa no staging, aviso à
  equipe; 15h41: autorização total, com produção só com PRODUCAO)
- **Onde conferir:** `.claude/hooks/guard-production.sh`, `wings-deploy production` (pede PRODUCAO digitado),
  `.githooks/pre-push`

## Contexto

Os agentes trabalham sozinhos e integram no staging. A produção é usada pela equipe todo dia e guarda os dados reais.

## Decisão

- Nada vai para a produção, nem é escrito nela, nem entra na `main` para ela, sem o Eric liberar: ele mesmo digita
  PRODUCAO no `wings-deploy production`. Nenhum agente digita PRODUCAO nem define `WINGS_ALLOW_PRODUCTION`.
- Cada etapa da produção: cópia manual do banco antes; aviso à equipe preparado pelo Zeus e mandado pelo Eric; nada
  publicado no staging desde 1 h antes até o fim da conferência (arquivo PAUSADO).
- Voltar atrás: o programa volta (revert e `wings-deploy production`) e o banco fica; restaurar a cópia só em último caso,
  decidido pelo Eric.

## Motivo

Produção, dinheiro, segredos e mensagens para pessoas ficam com o Eric (`/opt/agentes/politica.md`).

## Consequências

- Uma trava que bloqueia (hook, permissão, confirmação digitada) é sinal de parar e perguntar ao Eric, nunca erro para
  contornar.
- No staging, a integração é automática depois da revisão aprovada e da CI verde (política, item 4). Quem implementa a
  tarefa não mescla nem publica: as regras de cada execução da fila proíbem.
- Um deploy por vez, staging ou produção.
