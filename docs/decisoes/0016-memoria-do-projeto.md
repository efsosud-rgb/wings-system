# 0016 — Decisões e lições ficam no repositório, e todo agente lê antes de trabalhar

- **Data:** 30/10/2026 (método de trabalho; auditorias que se repetem, 15h27)
- **Quem decidiu:** Eric
- **Situação:** em vigor
- **Fonte:** tarefa adr01 ("Método de trabalho do Eric (30/10/2026)"); `/opt/hermes/entrada/decisoes-2026-10-30.md`
  ("Método de trabalho (15h27)": auditorias de segurança toda segunda e de arquitetura a cada 2 semanas, só leitura);
  `/opt/agentes/modelos/licoes.md`
- **Onde conferir:** este diretório, [`../licoes.md`](../licoes.md), o início do `AGENTS.md`

## Contexto

As decisões estavam espalhadas em vários documentos e nos arquivos de decisões do Eric fora do repositório. Os erros já
cometidos estavam num caderno fora do repositório, que nem todo agente lia.

## Decisão

- Cada decisão de arquitetura ou de forma de trabalho vira um arquivo em `docs/decisoes/`, com data, motivo, quem
  decidiu e fonte, no formato de [`modelo.md`](modelo.md).
- O caderno de lições tem uma cópia em `docs/licoes.md`.
- Todo agente lê `docs/decisoes/` e `docs/licoes.md` antes de trabalhar (`AGENTS.md`).
- A revisão de arquitetura (a cada 2 semanas, só leitura) compara o código com estes registros.
- Cada erro, vindo do portão, da CI ou da revisão, vira um teste que o pega, uma lição e, quando der, uma regra
  automática (lint, tipo ou teste de invariante).

## Motivo

Todo agente seguir as mesmas decisões, e a revisão de arquitetura ter com o que comparar o código (tarefa adr01).

## Consequências

- Decisão de regra de negócio continua em [`../decisoes.md`](../decisoes.md) (uma por linha) e regra que o código garante
  em [`../invariantes.md`](../invariantes.md).
- O caderno mestre continua em `/opt/agentes/modelos/licoes.md`, onde o Zeus junta as lições novas; quem atualiza o
  mestre atualiza a cópia `docs/licoes.md` no mesmo dia, por PR.
