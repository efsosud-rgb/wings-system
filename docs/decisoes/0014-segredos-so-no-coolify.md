# 0014 — Segredos só nas variáveis do Coolify, e quem cola é o Eric

- **Data:** 16/09/2026 (`README.md` e `docs/deploy.md`); 29/10/2026 (política: chaves, senhas e tokens só com o Eric)
- **Quem decidiu:** Eric (política de 29/10); a regra do repositório existe desde o primeiro commit
- **Situação:** em vigor
- **Fonte:** `/opt/agentes/politica.md` ("Chaves, senhas e tokens: quem cola é sempre ele"); `AGENTS.md`, seção 3
  ("Secrets and personal data"); `docs/deploy.md` ("Segredos"); `/opt/hermes/entrada/decisoes-2026-10-29.md`
  (senha de app do remetente: quem gera é a dona da conta, quem cola é o Eric)
- **Onde conferir:** `.env.example` (só nomes), `.claude/hooks/guard-secrets.sh`, chaves de criptografia separadas
  (`CPF_ENCRYPTION_KEY`, `CPF_INDEX_KEY`, `INTEGRATIONS_ENCRYPTION_KEY`)

## Contexto

O sistema usa tokens da Meta, do Google e de provedores de IA, chaves de criptografia do CPF e senhas de e-mail.

## Decisão

- Valores de segredo ficam nas variáveis de ambiente do Coolify; fora dele, só num arquivo modo 600 fora do repositório.
- O repositório, os documentos e o `.env.example` têm só os nomes das variáveis.
- Quem cola chave, senha ou token é sempre o Eric; nenhum agente cria, troca ou imprime um.
- Tokens de serviços externos nunca saem da API: não vão para a tela, para um modelo de IA nem para log.

## Motivo

Segredo vazado num commit, num log ou num chat não volta atrás.

## Consequências

- Perder a `CPF_ENCRYPTION_KEY` torna os CPFs guardados irrecuperáveis: ela tem cópia fora do servidor.
- A trava `guard-secrets` bloqueia comandos que imprimem valores de segredo.
