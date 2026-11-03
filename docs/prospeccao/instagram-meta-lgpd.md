# Prospecção Instagram — Meta e LGPD

Continuação de [instagram.md](instagram.md) (mesma versão de 29/10/2026, mesma base de código, mesmas marcas e mesmas fontes oficiais, listadas no §0 de lá). Separado só para cada arquivo ficar abaixo de 600 linhas; a numeração das seções é a mesma, e "§N" sem arquivo aponta para [instagram.md](instagram.md) quando N não é 7 nem 8.

## 7. Meta: o que o Eric aprova e faz (nada disso é feito agora)

### 7.1 Qual app

|             | Wings Traffic Agent                                                                                                                        | Wings CRM Vendas                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Hoje        | escreve campanhas e recebe Meta Lead Ads (`META_APP_SECRET`, `META_WRITE_TOKEN`, `META_LEADS_ACCESS_TOKEN`; `docs/leads/meta-lead-ads.md`) | WhatsApp Cloud API (`WHATSAPP_APP_ID`, `WHATSAPP_APP_SECRET`)                                                       |
| Quem indica | a pendência t024 e esta tarefa                                                                                                             | a spec PA (anexo 7, §10.1): empresa verificada, e o app que conversa com pessoas fica separado do que mexe em verba |

**Adotado (opção segura, valendo para os dois):** o código do Instagram lê só variáveis próprias (`INSTAGRAM_*`), com um **token só de Instagram**, gerado por um usuário do sistema com apenas as permissões de §7.2 e nenhuma `ads_management`. Nunca reaproveita `META_WRITE_TOKEN`: um token vazado do Instagram não mexe em verba. Escolher o app é configuração; o passo a passo abaixo está escrito para o **Wings Traffic Agent**, como pede a t024, e a diferença para o CRM Vendas está em §7.4. **Pergunta 1** (§11).

**Erro #10 da t024: —.** O repositório não registra onde ele aparece. Pela Graph, código 10 é permissão negada; o código já o trata como "A conta da Wings não está autorizada a consultar o Instagram" (`instagram-check.ts:103-108`). Hipótese a conferir na tela: o `INSTAGRAM_DISCOVERY_TOKEN` não tem as permissões da referência da Business Discovery (`instagram_manage_insights`, `pages_read_engagement`) ou o app não tem acesso avançado. Resolver isso é o primeiro passo da Fase B.

### 7.2 Permissões novas (nome exato)

| Uso                                               | Login pelo Facebook (Página)                                                                                        | Login unificado                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Ler comentários pelo webhook (parte 1)            | `instagram_basic`, `instagram_manage_comments`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list` | `instagram_manage_comments`                                                 |
| Resposta privada (parte 1)                        | `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement` + `instagram_manage_messages` (§0, adotado) | `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages` |
| Webhook `messages` (resposta da pessoa)           | o quadro oficial marca "não disponível" nesta coluna: conferir na tela se vem pela Página                           | `instagram_manage_messages`                                                 |
| Business Discovery (parte 3)                      | `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`                                             | as mesmas (adotado, §0)                                                     |
| Papel na Página dado pelo Gerenciador de Negócios | + `ads_read` (só leitura; a referência aceita `ads_management` **ou** `ads_read`)                                   | —                                                                           |

O login pelo Instagram (`instagram_business_*`) fica fora: a Business Discovery não aparece para ele (§0). Não pedir `ads_management`, `instagram_content_publish`, `business_management` nem a permissão de atendente humano. A spec PA recomenda o login unificado; a pergunta 2 (§11) fica com o Eric.

### 7.3 Passo a passo da revisão do app

Depende de: Fase C no staging com as chaves desligadas; política de privacidade e página de exclusão de dados publicadas (t063, §8.2); Jurídico de acordo (t066, t067).

1. **Conferir o portfólio** (Configurações do negócio): o app escolhido, a Página Wings Company e o @ da Wings no mesmo portfólio; empresa verificada (a verificação é exigida para acesso avançado, §0).
2. **Instagram no celular:** conta profissional, **pública**; Configurações → Mensagens → Ferramentas conectadas → **Permitir acesso a mensagens** (o nome do menu muda entre versões: conferir na tela).
3. **App → Adicionar produto → Instagram**, no modo de login escolhido.
4. **Configurações → Básico:** ícone, categoria, URL da política de privacidade, URL de instruções de exclusão de dados (a pendência t024 cita as duas e o ícone).
5. **Funções do app → Testadores:** contas da equipe que vão comentar nos testes (cada uma aceita o convite). Em desenvolvimento, só elas são vistas.
6. **Token:** Usuários do sistema → (usuário do sistema do Instagram) → atribuir a conta do Instagram e a Página → gerar token do app, sem expiração, **só** com as permissões de §7.2 → o Eric grava em `INSTAGRAM_MESSAGING_TOKEN` no Coolify do staging (nunca no chat). `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` (texto aleatório de 32+ caracteres) e `INSTAGRAM_APP_SECRET` (a chave secreta do app; no Traffic Agent é a mesma do `META_APP_SECRET`) idem.
7. **Webhooks → Instagram:** URL `https://staging.wingssystem.online/api/integrations/instagram/webhook`, o token de verificação, "Verificar e salvar"; assinar `comments`, `messages`, `mentions`, `messaging_referral`; inscrever a conta (`subscribed_apps`), pelo Eric no Explorador da Graph.
8. **Chamadas de teste:** pelo menos uma chamada bem-sucedida de cada permissão nos 30 dias antes do envio (§0): um comentário de testadora, uma resposta privada pelo clique, uma Business Discovery de uma conta comercial de exemplo.
9. **Gravar os vídeos** (§7.5) e enviar: Revisão do app → Permissões e recursos → pedir acesso avançado de cada permissão, com o texto de uso em inglês.
10. **Aprovado:** passar o app para Live; ligar `INSTAGRAM_WEBHOOK_ENABLED` e depois o modo `clique`; produção só na janela que o Eric abrir (PRODUCAO).

### 7.4 O que muda no app Wings Traffic Agent

| Item                                                            | Muda?                                                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Produto Instagram e as permissões de §7.2                       | sim, acrescentados                                                                                                                     |
| Webhook do objeto Instagram (URL nova)                          | sim, acrescentado; o webhook `leadgen` da Página fica igual                                                                            |
| Ícone, URL de exclusão de dados, política                       | sim (t024); a política já é exigida para o modo Live do Lead Ads                                                                       |
| Testadores                                                      | sim                                                                                                                                    |
| `META_WRITE_TOKEN`, `META_LEADS_ACCESS_TOKEN`, campanhas, verba | **não**: nenhuma permissão de anúncio é pedida ou mudada; o token novo é outro                                                         |
| Modo Live                                                       | se o app já estiver Live por causa do Lead Ads, ele continua; as permissões novas só valem para quem não tem papel depois da aprovação |

Se o Eric escolher o **Wings CRM Vendas**: os mesmos passos nesse app; `INSTAGRAM_APP_SECRET` passa a ser a chave dele; nada muda no Traffic Agent.

### 7.5 Vídeo de tela que a Meta pede

Regras do guia (§0): 1080 ou mais, sem áudio (legendas em inglês na tela), mostrando a pessoa concedendo a permissão e o uso; dados só das contas de teste. Um vídeo por permissão, a partir do roteiro da spec PA (anexo 7, §10.8), com estas trocas:

| Permissão                                                               | O vídeo mostra                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instagram_manage_comments`                                             | testadora comenta "quanto custa?" num post da Wings → a oportunidade aparece com o trecho, o sinal "pediu preço" e o prazo; um "top!" não vira nada                                                                         |
| `instagram_manage_messages`                                             | o clique "Enviar resposta privada" → a mensagem fixa chega uma vez na conta de teste, com o link da política → a testadora responde com um telefone fictício → vira lead → "PARAR" grava o "não me contate" e nada mais sai |
| `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement` | busca do Google com uma empresa de teste que tem Instagram comercial → a coluna Instagram mostra seguidores, posts e a nota; uma conta pessoal mostra "—"                                                                   |
| `pages_show_list`, `pages_manage_metadata` (login pela Página)          | escolha da Página ligada e a inscrição do webhook                                                                                                                                                                           |

---

## 8. LGPD

Rascunho técnico, não parecer. **Tudo a validar pelo Jurídico** (t066 antes de qualquer contato real; t067 para a resposta pelo Direct; t063 para a política).

### 8.1 Base legal proposta

| Tratamento                                                                                     | Base proposta                                                                                                                                   | Observação                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parte 2: @ e trecho de comentário público em post de concorrente, abordagem manual pelo Direct | legítimo interesse (art. 7º, IX), com o teste de 3 fases da ANPD                                                                                | **Divergência:** a spec PA (anexo jurídico, §2, tratamento C) deixava pessoa física **fora** do radar de concorrentes. A decisão do Eric de 29/10 às 16:35 inclui pessoas. Salvaguardas: só quem demonstrou interesse; trecho mínimo; nada de telefone ou e-mail do comentário; contato um a um, à mão; aviso na primeira mensagem; 30 dias; "não contatar" permanente. **O piloto com pessoas reais espera o Jurídico.** Ponto para o Jurídico: os Termos de Uso do Instagram proíbem coletar dados "de forma automatizada"; aqui a cópia é humana e o sistema não acessa o Instagram, mas a leitura do texto colado é automática |
| Parte 1: primeira resposta privada a quem comentou num post ou anúncio da Wings                | legítimo interesse (art. 7º, IX) para a primeira mensagem; procedimentos preliminares a pedido do titular (art. 7º, V) quando a pessoa responde | igual à spec PA (tratamento A)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Parte 3: números públicos de conta comercial de empresa                                        | legítimo interesse; em geral não é dado pessoal, mas pode ser de empresário individual                                                          | só números, sem nome, bio ou foto                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 8.2 Aviso na primeira abordagem

- **Parte 1:** a resposta privada (§5.4) já traz finalidade, como parar e o link da política.
- **Parte 2, texto que a vendedora copia (proposta):**

> Oi! Sou {nome_vendedora}, da Wings Company, consultoria de franquias e gestão. Vi o seu comentário no post de @{conta_do_post} e achei que podemos ajudar. Posso te contar como funciona?
> Se não quiser receber contato, é só responder "não" que não falamos mais. Privacidade: {link_politica}

- `{link_politica}`: a política do site, que hoje está registrada como inexistente (`docs/ads/fechar-ciclo.md`, citado na spec PA). Sem política publicada, a Fase C não vai à revisão da Meta e a parte 2 não vai ao piloto com pessoas reais.

### 8.3 "Não contatar" permanente

- Tudo passa pela trava única que já está na develop (`contact_opt_outs`, `contactBlock`; `docs/crm/nao-me-contate.md`), canal `instagram`, chave `instagram_user` (o @).
- Gravado por: botão "Não contatar" (parte 2, origem `prospeccao`); "PARAR" e as outras palavras no Direct (parte 1, origem `instagram`); pedido de exclusão.
- Consultado **antes** de listar (parte 2: quem está no cadastro nem vira prospect) e antes de toda resposta privada (parte 1).
- Não expira e não é apagado pelo expurgo de 30 dias: é o que garante a oposição. Revogar só pela tela da trava, com motivo.
- Limite conhecido: o @ pode mudar. Na parte 1 a spec PA acrescenta a chave `instagram_igsid` (PR D5).

### 8.4 Expurgo em 30 dias

- Agendador da spec PA (`prospect-ai:housekeeping`, 1 h): prospect do Instagram que **não virou lead** em `retention.instagramSemLeadDias` (30, decisão do Eric nesta tarefa) desde a última mudança (criação, "Abordei", transferência) é apagado: a evidência inteira (@, trecho, link) e a oportunidade. Fica só a contagem no `dw` e no `audit_log` (`prospect_ai.instagram_purged`, `{ count, days }`).
- **Divergência:** a spec PA propõe 90 dias para oportunidade sem lead e `ig_people`. Para as origens do Instagram vale 30 (pedido do Eric); a regra de 90 da spec PA fica para as outras origens, se houver.
- `instagram_business_snapshots`: apagado 30 dias depois de `fetched_at`.
- `instagram_discovery_calls`: apagado 30 dias depois de `created_at`. Não tem @, mas tem o id da vendedora que pediu (dado de pessoa, ainda que interno); o teto só conta as linhas do dia.
- `ig_paste_batches`: fica (só contagens e o link do post de uma empresa).
- O texto colado nunca é gravado (§2.2); o cache do classificador guarda só hash e saída, 30 dias (spec PA). A saída inclui a `frase` da IA: um trecho de até 200 caracteres do texto **já mascarado** (sem @, telefone, e-mail, link nem 4 dígitos seguidos), que não diz de quem é. Os 30 dias contam da criação e não seguem `retention.instagramSemLeadDias` (dúvida para o Eric em aj03). Teste: `classifier.test.ts`, "the cache keeps the hash and the masked output".
- Teste: com o relógio adiantado 31 dias, nenhuma linha com o @ fica no banco além de `contact_opt_outs`.

### 8.5 Sem dado pessoal no `dw` e nos logs

§2.7. Logs só com ids, códigos e formatos (`shapeOf`); nunca @, trecho, texto colado ou resposta da IA (`AGENTS.md`, "Personal data must never be logged").
