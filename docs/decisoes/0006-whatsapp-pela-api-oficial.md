# 0006 — WhatsApp pela API oficial da Meta, sem ferramenta intermediária

- **Data:** 30/09/2026 (API oficial); 27/10/2026 (sem ferramenta intermediária paga)
- **Quem decidiu:** Eric
- **Situação:** em vigor; a distribuição dos números está em [0007](0007-numeros-do-whatsapp.md)
- **Fonte:** `docs/decisoes.md` (linhas de 30/09 e 27/10); `docs/whatsapp/cloud-api.md`; `docs/whatsapp/requisitos.md`
- **Onde conferir:** `apps/api/src/modules/whatsapp/` (`graph.ts`, webhook com `X-Hub-Signature-256`),
  `apps/api/src/modules/sofia/`

## Contexto

O CRM e a Sofia (a SDR automática) conversam com leads pelo WhatsApp. Há caminhos não oficiais e ferramentas pagas que
ficam no meio entre o sistema e a Meta.

## Decisão

- O CRM e a Sofia usam a API oficial da Meta (Cloud API), com os modelos aprovados pela Meta e a Calling API para voz.
- Nenhuma ferramenta intermediária paga entre o sistema e a Meta.

## Motivo

A escolha da API oficial não tem motivo registrado (`docs/decisoes.md`: "confirmar com o Eric"). Sem intermediário:
sem custo extra (linha de 27/10).

## Consequências

- O webhook só aceita POST com assinatura válida do segredo do app; token e segredos ficam no Coolify.
- Toda saída passa antes pela trava única de "não me contate" (todas as chaves do contato e do lead), pelo SAIR, pelo
  opt-in e pela janela de 24 h; recusa responde e encerra a ação (lições 3 e 4 de [`../licoes.md`](../licoes.md)).
- O staging usa o número de teste da Meta, que só entrega para números cadastrados no app.
- Mudança no app ou na conta da Meta é só com o Eric (`/opt/agentes/politica.md`).
