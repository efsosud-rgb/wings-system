# 0013 — Anúncio e verba só por ordem do Eric, sem automação de gasto

- **Data:** 09/10/2026 ("Nunca mais suba um anúncio sozinho"); 29/10/2026 (automação de gasto proibida até as travas de
  verba ficarem prontas); 02/11/2026 (travas prontas, regra mantida)
- **Quem decidiu:** Eric
- **Situação:** em vigor
- **Fonte:** `docs/decisoes.md` (linha de 09/10); `AGENTS.md`, seção 3 ("Never create, publish, resume or change the
  budget of an ad", "No automation on ad spend"); `/opt/hermes/entrada/decisoes-2026-10-29.md` ("Campanhas de tráfego",
  "Travas de verba"); `/opt/agentes/politica.md` ("Dinheiro")
- **Onde conferir:** `docs/ads/travas.md` ("O bloqueio de automação depois da parte 2"), `reserveChange` e o portão de
  aprovação em `apps/api/src/modules/ads/`, `docs/ads/agente-conversa.md`

## Contexto

A Wings não tem conta de anúncio de teste: toda ação em anúncio gasta dinheiro real.

## Decisão

- Nenhuma campanha, conjunto ou anúncio é criado, publicado, reativado ou tem a verba mudada sem ordem explícita do Eric
  naquele momento.
- Nenhuma automação de gasto: nenhum agente pede mudança, nada aprova sozinho, nenhum worker executa. Uma pessoa aprova
  e executa uma mudança por vez.
- O agente de tráfego só lê as tabelas do sistema e propõe; a proposta só vira ação com o clique de uma pessoa.

## Motivo

Toda ação em anúncio gasta dinheiro real (`AGENTS.md`).

## Consequências

- As travas de verba (partes 1 e 2) ficaram prontas em 02/11, mas a automação continua proibida até o Eric tirar a regra.
- Nada muda nas contas de anúncio sem o OK do Eric, nem para fechar o ciclo de conversões (30/10, 13h58).
