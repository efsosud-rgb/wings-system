# 0010 — Revisão independente antes de juntar

- **Data:** 27/10/2026 (nada entra sem PR e revisão independente); 29/10/2026 (política, item 3); 30/10/2026, 15h27
  (segunda opinião de outra IA nos PRs de risco)
- **Quem decidiu:** Eric
- **Situação:** em vigor
- **Fonte:** `docs/decisoes.md` (linha de 27/10 do portão de qualidade); `/opt/agentes/politica.md` ("Toda mudança passa
  por revisão independente"); `/opt/agentes/modelos/revisor.md`; `/opt/hermes/entrada/decisoes-2026-10-30.md` ("Método
  de trabalho (15h27)")
- **Onde conferir:** `/opt/agentes/modelos/revisor.md` (passos e veredito), `/opt/agentes/segunda-opiniao.py`

## Contexto

Correções de segurança ficaram fora da produção e regressões passaram sem ser vistas (auditoria de 27/10). Quem
escreveu o código tende a confirmar o próprio raciocínio.

## Decisão

- Toda mudança entra por PR e passa por revisão de outro agente, que não vê a pasta nem o relatório de quem fez: forma a
  opinião só pelo PR e pelo código.
- O revisor roda o portão de qualidade num banco descartável próprio, faz a mutação dos testes novos (quebra a linha
  principal, vê o teste falhar, restaura) e grava um veredito: aprovado, aprovado com ressalvas ou reprovado.
- Nos PRs de risco, há ainda a segunda opinião de outra IA (custo por uso, autorizado pelo Eric).
- O merge só acontece com a revisão aprovada e a CI verde.

## Motivo

Pegar o erro antes de juntar, com quem não está preso ao raciocínio de quem escreveu.

## Consequências

- Um erro que já está no caderno de lições e reaparece num PR é bloqueio na revisão.
- Reprovação só por problema real: bug, teste falso ou faltando, risco de segurança ou LGPD, migração quebrada, portão
  vermelho ou PR que não faz o que diz.
- A proteção de branch do GitHub não está disponível no plano atual: quem segura a `develop` e a `main` é esta regra,
  o PR e as travas (`CLAUDE.md`, "O gancho é uma ajuda, não uma trava").
