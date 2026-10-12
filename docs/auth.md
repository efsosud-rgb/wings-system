# Autenticação, convites e redefinição de senha

## Fluxos

| Rota                             | Quem usa                       | Resultado                                            |
| -------------------------------- | ------------------------------ | ---------------------------------------------------- |
| `POST /api/auth/login`           | qualquer funcionário ativo     | cria sessão, cookie `wings_session`                  |
| `POST /api/auth/logout`          | sessão ativa                   | encerra a sessão e registra saída no ponto           |
| `GET /api/auth/me`               | sessão ativa                   | dados do usuário e permissões efetivas               |
| `POST /api/auth/invite`          | quem tem `employees.create`    | envia (ou reenvia) o convite de primeira senha       |
| `POST /api/auth/forgot-password` | público                        | sempre responde `202`; envia link se a conta existir |
| `POST /api/auth/set-password`    | link de convite ou redefinição | grava a senha e encerra todas as sessões             |

**Ninguém define a senha de outra pessoa.** O gestor cria o funcionário e o
sistema envia o convite; a senha é escolhida pelo próprio funcionário.

## Sessão vencida com a aba aberta

A sessão acaba sozinha no servidor: **30 minutos sem atividade** ou **12 horas
desde o login** (`SESSION_IDLE_MINUTES` e `SESSION_ABSOLUTE_HOURS` em
`packages/shared/src/auth/schema.ts`, constantes, sem variável de ambiente), ou
na hora, ao desativar a pessoa ou trocar o nível de acesso. Consultas que a tela
repete sozinha (cabeçalho `x-wings-passive: 1`: ligações tocando, conversas,
painéis) **não contam como atividade**; só o que a pessoa faz conta.

Depois disso toda chamada responde `401` (`session_expired` na primeira,
`unauthenticated` nas seguintes, porque o cookie é apagado). Uma aba esquecida
aberta não sabe disso sozinha, então o navegador tem **um só lugar** que reage:

- O cliente HTTP (`apps/web/src/api/client.ts`) avisa o guarda
  (`session-guard.ts`) de qualquer `401`, exceto o do próprio `/auth/login`
  (senha errada). Os poucos pedidos que não passam pelo cliente (envio de
  arquivo, conversa do agente, exportação CSV) avisam por `noteUnauthorized`.
- Com alguém logado na aba, o guarda zera a sessão em cache. O portão de rotas
  (`ProtectedRoute`) manda para `/login` levando **a tela onde a pessoa estava**
  (caminho, `?consulta` e `#trecho`) e o aviso _"Sua sessão expirou. Entre de
  novo."_. Sair da tela desmonta o menu e, com ele, toda consulta periódica:
  nenhuma segue perguntando.
- Ao entrar de novo, a pessoa volta para essa tela. O endereço de retorno só
  vale se for um caminho do próprio sistema (nunca `//outro-site`, nem as telas
  públicas); o cache da sessão anterior é apagado no login.
- Ao voltar para uma aba que ficou em segundo plano, uma checagem passiva de
  `/auth/me` (no máximo a cada 30 s) descobre a sessão vencida mesmo numa tela
  sem consulta periódica.
- Recarregar a página depois do vencimento mostra o mesmo aviso: uma marca em
  `localStorage` (`wings:signed-in`, sem dado da pessoa) diz que este navegador
  já teve sessão; o logout a apaga.

Tela que não conseguiu carregar mostra **"—" e o motivo**
(`components/LoadFailure.tsx`, `lib/failure.ts`), nunca um vazio inventado
("Nenhuma tarefa", "0").

## Regras dos links

- Token de 32 bytes aleatórios; o banco guarda apenas o **SHA-256**.
- **Uso único** (`credential_tokens.used_at`) e sempre com validade:
  convite **7 dias**, redefinição **60 minutos**.
- Reenviar um convite **invalida o link anterior**.
- Definir a senha **revoga todas as sessões** do funcionário.
- `POST /auth/forgot-password` responde igual para e-mail existente ou não —
  um visitante anônimo não pode descobrir quem tem conta.

## Política de senha

Mínimo de 12 caracteres, sem espaços nas pontas. São recusadas senhas que
contenham o nome da conta (parte antes do `@`), sequências óbvias
(`123456`, `qwerty`, `abcdef`) ou que sejam apenas uma palavra fraca
(`senha`, `wings2026`). Uma frase longa como `minha-senha-bem-longa-2026` é
aceita — o objetivo é barrar o óbvio, não bons passphrases.

## Configuração de e-mail (Google Workspace)

Variáveis de ambiente no Coolify:

| Variável        | Exemplo                                      | Observação                                |
| --------------- | -------------------------------------------- | ----------------------------------------- |
| `SMTP_HOST`     | `smtp.gmail.com`                             |                                           |
| `SMTP_PORT`     | `587`                                        | STARTTLS; use `465` para TLS implícito    |
| `SMTP_USER`     | `sistema@wingscompany.com.br`                | caixa do Google Workspace                 |
| `SMTP_PASSWORD` | senha de app                                 | exige verificação em duas etapas na conta |
| `SMTP_FROM`     | `Wings System <sistema@wingscompany.com.br>` |                                           |
| `APP_BASE_URL`  | `https://staging.wingssystem.online`         | monta os links dos e-mails                |

Sem SMTP configurado, as rotas que dependem de e-mail respondem **503
`email_not_configured`** — nunca fingem sucesso. Em desenvolvimento local, sem
SMTP, a mensagem é apenas registrada no log (o link só aparece fora de
produção).
