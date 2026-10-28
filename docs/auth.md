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
na hora, ao desativar a pessoa, trocar o nível de acesso ou trocar o e-mail de login. Consultas que a tela
repete sozinha (cabeçalho `x-wings-passive: 1`: ligações tocando, conversas,
painéis) **não contam como atividade**; só o que a pessoa faz conta.

O aviso de ligação tocando é uma resposta que fica aberta
(`GET /whatsapp/calls/stream`, `docs/whatsapp/cloud-api.md`) e segue a mesma
regra, por conta própria: a rota é **passiva à força** (o servidor põe o
cabeçalho, venha ou não do navegador), então um stream aberto nunca mantém
viva uma sessão ociosa. A cada batimento (15 s) a API olha a sessão sem
renová-la: ociosa por 30 minutos ou passada de 12 horas, ela é fechada ali
como numa consulta passiva (a saída do ponto fica no último movimento real) e
o stream manda `session_ended` e fecha. Sair (logout), desativar a pessoa ou
trocar o nível fecham os streams dela na hora, sem esperar o batimento. Na
aba, `session_ended` e um `401` ao abrir o stream chegam ao mesmo guarda de
sessão e não reabrem nada.

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

## Troca do e-mail de login e inativação

Decidido em 13/10/2026, depois da auditoria de segurança. Quem controla o
e-mail de login controla a conta (o "esqueci minha senha" vai para ele), então:

- **Só troca o e-mail de login de alguém quem também poderia mudar o nível de
  acesso dessa pessoa** (`loginEmailChangeDenial` em `packages/shared`, ao lado
  de `roleChangeDenial`; a tela e a API usam a mesma regra). Na prática: o
  RH/DP não troca o de quem é da Diretoria; ninguém troca o próprio, salvo o
  Admin Master; e um gestor de setor ou o Gerente Comercial não troca o de um
  colega de nível igual ou maior (nem muda o nível desse colega, para não abrir
  o e-mail em dois passos). Recusa: `403 email_change_forbidden`.
- **Se a pessoa é gestora de setor, quem troca o e-mail dela precisa ter todos
  os poderes que essa marca dá** (ver, cadastrar, editar, inativar, definir
  nível e ver o ponto no setor dela, com alcance igual ou maior). Assim o
  Gerente Comercial, que não inativa ninguém, não ganha esse poder tomando a
  conta de um subordinado gestor. O RH/DP e o Admin Master têm todos esses
  poderes; só o Admin Master liga ou desliga a marca.
- Ao trocar: **todas as sessões da pessoa são encerradas**, os **links de
  convite e de redefinição ainda válidos deixam de funcionar**, e o **endereço
  antigo recebe um aviso** (sem o endereço novo). A tela diz se o aviso saiu; se
  não saiu (sem SMTP ou falha do servidor), diz "NÃO foi enviado". Na
  auditoria: `employee.updated` (campo `email`, quantos links foram cancelados)
  e `credentials.email_change_notified` (entregue ou o motivo), nunca o endereço.
- **Inativar ou reativar exige `employees.deactivate`** sobre o setor da pessoa
  (`statusChangeDenial`); editar o cadastro não basta. Ativo ↔ afastado continua
  uma edição comum. Recusa: `403 deactivate_forbidden`.
- **Auditoria de 27/10/2026 (A2 e A3).** Quem não tem `employees.assign_roles`
  (gestor de setor, Gerente Comercial) só atribui um nível abaixo do seu **se já
  tiver todas as permissões desse nível, com escopo igual ou maior**: um nível
  "menor" pode carregar poderes que o gestor não tem (o Marketing tem anúncios e
  clientes; o Jurídico vê o CPF dos sócios), e cadastrar essa conta ou mudar um
  subordinado para ela e ficar com o login entregaria esses poderes. Recusa:
  `role_permissions_exceed` (a tela simplesmente não oferece o nível). Pela mesma
  regra, quem não pode mudar o nível de alguém não troca o e-mail de login dele.
  E esse gestor também **não inativa nem reativa quem está acima dele**, nem Admin
  Master ou Diretoria; colegas do mesmo nível continuam com ele.

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
