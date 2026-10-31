# Prospecção Instagram — Fase A construída (parte 2: comentários colados)

Construída em 31/10/2026 (tarefa ig02) a partir da [especificação](instagram.md), §1.2, §2, §3, §4, §8.3, §8.4, §9 e §10 (Fase A). Esta página diz o que existe, onde está e o que ficou diferente da especificação. **Nada liga sozinho:** a colagem fica desligada até o Eric ligar, depois do OK do Jurídico (t066) e da política de privacidade publicada (t063).

## Como se usa

CRM Vendas → Prospecção → aba **Instagram** (quem tem `prospecting.instagram_paste`).

1. **Colar comentários:** o link do post (obrigatório), o @ do dono (opcional) e o texto copiado à mão do Instagram. "Ler comentários" mostra a prévia: comentários reconhecidos, linhas ignoradas (por tipo), as 20 primeiras não reconhecidas e quem já é conhecido ("não contatar", cliente, lead, na lista de alguém). Nada é gravado nem vai para a IA nessa hora.
2. **"Separar quem quer comprar (N comentários)":** grava a colagem (só contagens e o link) e, por comentário aproveitável, o trecho mascarado e o prospect, em **Quer comprar**, **Revisar** ou **Outros**.
3. **Minhas listas:** em cada prospect, "Abrir no Instagram", "Copiar mensagem", "Abordei", "Criar lead", "Não contatar", "Descartar", "Mover para Quer comprar" e, para a gerência, "Transferir". Nada sai do sistema: a vendedora escreve pelo Direct da Wings.

## Onde está

| Peça                                               | Arquivo                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Leitura do texto, datas, máscara, link do post     | `packages/shared/src/instagram-paste.ts`                                       |
| Estados, sinais, limiares, configuração, Zod       | `packages/shared/src/prospect-ai.ts`                                           |
| Tabelas (migração `0105_prospect_instagram_paste`) | `apps/api/src/db/schema/prospect-ai.ts`                                        |
| Classificador (regras + lote de 20, teto, cache)   | `apps/api/src/modules/prospect-ai/classifier.ts`                               |
| Prévia e confirmação                               | `apps/api/src/modules/prospect-ai/paste.ts`                                    |
| Listas e ações                                     | `apps/api/src/modules/prospect-ai/prospects.ts`                                |
| Rotas `/prospect-ai/instagram/*`                   | `apps/api/src/modules/prospect-ai/instagram-routes.ts`                         |
| Expurgo de 30 dias (a cada hora)                   | `apps/api/src/modules/prospect-ai/housekeeping.ts`                             |
| Tela                                               | `apps/web/src/pages/crm/InstagramProspecting.tsx`, `InstagramProspectList.tsx` |

## Chaves (todas desligadas por padrão)

| Variável                              | Padrão  | O que faz                                                                                                                               |
| ------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PROSPECT_AI_INSTAGRAM_PASTE_ENABLED` | `false` | Desligada, toda rota menos `/status` responde 503 e a aba diz por quê                                                                   |
| `PROSPECT_AI_CLASSIFIER_ENABLED`      | `false` | A IA (Haiku 4.5 pelo OpenRouter, sem coleta de dados). Desligada, as regras fixas rodam e o resto vai para "Revisar" com "IA desligada" |
| `PROSPECT_AI_DAILY_USD`               | `1`     | Teto da IA por dia (São Paulo), reservado sob trava antes de cada chamada                                                               |

Ajustes → Instagram (`prospect_ai.configure`: Gerente Comercial e Admin Master): limites da colagem, limiares, dias até apagar, o texto da primeira mensagem e o **link da política**. Sem o link, "Copiar mensagem" não copia nada e diz por quê.

## Rotas

| Rota                                                                                                  | Permissão                     | O quê                                                                              |
| ----------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `GET /prospect-ai/instagram/status`                                                                   | `prospecting.instagram_paste` | ligada?, IA ligada?, configuração, colagens de hoje                                |
| `POST /prospect-ai/instagram/pastes/preview`                                                          | + `leads.write`               | lê e cruza; não grava; sem IA. 400 link, 413 tamanho, 422 comentários demais       |
| `POST /prospect-ai/instagram/pastes`                                                                  | + `leads.write`               | grava e classifica; 429 `colagem_limite_dia`                                       |
| `POST /prospect-ai/instagram/pastes/attach`                                                           | + `leads.write`               | anexa o comentário (mascarado) à linha do tempo de um lead que a vendedora alcança |
| `GET /prospect-ai/instagram/pastes`, `/prospects`, `/owners`                                          | `prospecting.instagram_paste` | colagens, prospects (próprios ou todos), quem recebe transferência                 |
| `GET /prospect-ai/instagram/prospects/:id/message`                                                    | + `leads.write`               | o texto para copiar, com o primeiro nome da vendedora                              |
| `POST /prospect-ai/instagram/prospects/:id/{approached,promote,discard,do-not-contact,lead,transfer}` | + `leads.write`               | as ações; `transfer` e reabrir descartado só gerência                              |
| `PUT /prospect-ai/instagram/settings`                                                                 | `prospect_ai.configure`       | Ajustes, auditado com antes e depois                                               |

## O que ficou diferente da especificação (opção mais segura; perguntas no relatório da ig02)

- **Base da spec PA feita junto:** as tabelas `prospect_evidence`, `prospect_opportunities`, `prospect_classifications`, `prospect_classifier_cache`, `prospect_classifier_runs` e `prospect_ai_settings` entraram aqui, na forma do PR #54, só com o que a Fase A usa (sem `prospect_source_health`, sem `ig_person_id`). A evidência ganhou `opportunity_id` para ligar um segundo comentário do mesmo @ ao prospect aberto e para o expurgo levar tudo junto.
- **Interruptor da colagem** (`PROSPECT_AI_INSTAGRAM_PASTE_ENABLED`), que a especificação não pedia: abordar pessoas reais espera o Jurídico.
- **"Outros" fica guardado** como prospect `rejeitada` com o motivo "Outros: …", para a vendedora poder mover um item; é apagado em 30 dias como os demais.
- **O trecho também mascara outros @** (`[@]`), além de telefone, e-mail e link.
- **Formato em linha** (navegador do celular) só é aceito com o tempo no fim da linha ("5 d Responder"); sem ele, a linha vai para "não reconhecidas" e a tela sugere o formato `@usuario: texto`.
- **Sem `GRANT` para `wings_ro`** nas tabelas novas (têm @ e trechos).
- **Carga do `dw`** (contagens por dia × fonte × vendedor) fica para o painel por fonte da spec PA (F1): hoje nenhuma rotina carrega o `dw`. O teste que já existe confere que nenhuma coluna do `dw` tem nome de dado pessoal.
- **Serviços do classificador** são a lista padrão da spec PA, fixa no código (Ajustes dos serviços é da spec PA).

## Falta para ir às pessoas reais (fora da CI)

5 colagens reais conferidas pelo Eric (de posts da própria Wings, sem guardar), o OK do Jurídico (t066), a política publicada (t063) e o link dela em Ajustes; então o Eric liga `PROSPECT_AI_INSTAGRAM_PASTE_ENABLED` (e, se quiser, `PROSPECT_AI_CLASSIFIER_ENABLED`) no Coolify.
