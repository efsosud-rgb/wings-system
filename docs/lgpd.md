# LGPD — proteção de dados pessoais

Registros de funcionários contêm CPF, data de nascimento, telefone e e-mail.
Este documento descreve as medidas técnicas implementadas. Prazos de retenção e
base legal devem ser confirmados pelo Jurídico.

## CPF

| Medida                    | Implementação                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Criptografia              | AES-256-GCM na aplicação (`apps/api/src/lib/cpf-crypto.ts`). Formato: `base64(iv[12] ‖ authTag[16] ‖ ciphertext)` |
| Busca sem descriptografar | Índice cego HMAC-SHA256 com chave separada (`cpf_index`, com unicidade no banco)                                  |
| Exibição                  | Mascarada por padrão (`***.982.247-**`). O valor completo exige a permissão `employees.pii.view`                  |
| Auditoria                 | Toda exibição completa gera registro em `audit_log`                                                               |

As chaves `CPF_ENCRYPTION_KEY` e `CPF_INDEX_KEY` vivem nas variáveis de ambiente
do Coolify e precisam ser diferentes entre si (validado na inicialização).

> ⚠️ **Perder `CPF_ENCRYPTION_KEY` torna todos os CPFs irrecuperáveis.** Guarde
> uma cópia fora do servidor (gerenciador de senhas).

## Minimização

- Ponto eletrônico, sessões e auditoria referenciam o funcionário por ID —
  nunca copiam CPF, nome ou e-mail.
- `audit_log.metadata` é sempre um objeto JSON (validado por constraint) e deve
  conter apenas nomes de campos alterados, nunca valores pessoais.
- Logs da aplicação não podem conter dados pessoais.

## Controle de acesso

- Toda decisão passa por `can()` em `@wings/shared` (`rbac/policy.ts`).
- Diretoria é **totalmente bloqueada** dos registros do setor TI (regra de
  negação avaliada antes de qualquer concessão).
- Gestores de setor (`is_sector_manager`) só administram o próprio setor e não
  podem conceder papéis iguais ou superiores ao seu.

## Ciclo de vida

- Desligamento: `status = 'inactive'` com `deactivated_at` obrigatório
  (constraint no banco). O registro não é apagado.
- Anonimização após o prazo de retenção: **a definir com o Jurídico**.
- Backups do banco são criptografados e mantidos fora do servidor.
