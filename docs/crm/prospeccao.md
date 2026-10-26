# CRM Vendas → Prospecção (26/10/2026)

Branch `feat/crm-prospeccao`, migração **0096** `prospecting` (renumerar no merge se outra entrar antes). Pedido do Eric de 24/10: o vendedor de Formatação acha empresas no Google Maps, separa as boas, enriquece pelo site da própria empresa e, depois do primeiro contato, leva a empresa ao funil Formatação como lead.

Tela: `/crm-vendas/prospeccao` (menu CRM Vendas → Prospecção). Código: `apps/api/src/modules/prospecting/`, contrato em `packages/shared/src/prospecting.ts`, tela em `apps/web/src/pages/crm/ProspectingPage.tsx`, painel do lead em `apps/web/src/pages/crm/GooglePlacePanel.tsx`.

## Regras do Google (Maps Platform) e como são cumpridas

- **Só o `place_id` é guardado.** Nome, endereço, telefone, site, nota, avaliações, horário, tipos e link do Maps vêm ao vivo em cada resposta e não entram em tabela, log, auditoria nem linha do tempo do lead. As tabelas novas não têm coluna com esses nomes, e um teste (`prospecting.test.ts`) falha se uma aparecer; outro teste busca, reserva, abre a ficha, cria o lead e confere que nada do Google ficou no banco.
- **Ao vivo.** A busca e a ficha chamam o Google a cada clique; a tela guarda o resultado só na memória da página (nada no navegador). "Meus prospects" mostra só os nossos dados (status, dono, motivo, observações, o que o site mostrou); o nome e os contatos aparecem ao abrir a ficha.
- **Atribuição.** A lista mostra "Resultados do Google Maps" e cada empresa tem "Abrir no Google Maps" (o `googleMapsUri` da resposta). Nenhum outro mapa.
- **Nada do Google vai para IA.** A IA só transforma a frase do vendedor ("hamburguerias em Icaraí com nota 4,5+") em parâmetros (segmento, locais, nota mínima, avaliações mínimas, só com site). Ela nunca busca: o vendedor clica em "Usar no formulário" e depois em Buscar.
- **Chave só no servidor.** `GOOGLE_PLACES_API_KEY` vai no cabeçalho `X-Goog-Api-Key`, nunca numa URL, num log ou numa resposta. Sem ela, toda rota que chama o Google responde **503** `places_not_configured` ("Chave do Google não configurada.") e a tela mostra "— Chave do Google não configurada." antes de qualquer busca (`GET /prospecting/status`).
- Erro do Google: o log leva só o código e o status HTTP; a tela recebe 502 com "O Google não respondeu agora…" ou "O Google recusou a chave…". Nenhuma chamada é repetida (pode ter sido cobrada).

## Quem vê o quê

| Nível               | `prospecting.use`                     | `prospecting.configure` | `prospecting.quota` | Criar lead              |
| ------------------- | ------------------------------------- | ----------------------- | ------------------- | ----------------------- |
| Vendedor Formatação | own: os seus; o que outro segura some | —                       | —                   | sim (só dos seus)       |
| Gerente Comercial   | all: todos, com etiqueta; transfere   | sim                     | —                   | sim                     |
| Diretoria           | all                                   | —                       | —                   | não (sem `leads.write`) |
| Admin Master        | all                                   | sim                     | sim                 | sim                     |
| Vendedor Expansão   | — (403 em toda rota)                  | —                       | —                   | —                       |

Um prospect fora do alcance responde 404. "Segurar" é estar `reservado` ou `contatado`: o vendedor não vê na busca a empresa que outro segura (conta em "ocultos"); o gerente vê com "reservado por X".

## Cota de chamadas

Cada chamada ao Google conta 1. Padrão: **40 por pessoa por dia** e, para a empresa toda, **950 buscas e 950 fichas por mês** (dentro das 1.000 grátis de cada tipo). Dia e mês viram à meia-noite de São Paulo. Quem muda: Admin Master em Ajustes (`PUT /prospecting/settings/quota`, máximo 1.000 por mês).

As chamadas são reservadas antes de ir ao Google, numa transação com trava (`prospect_calls`, só inserção): ou cabem todas ou nenhuma vai. Uma chamada que falhou continua contada. Recusa: **429** `prospecting_quota` com a frase ("Você já usou as 40 chamadas ao Google de hoje…", "O mês chegou a 950 buscas…", "A varredura gasta N chamadas e só restam M hoje."). Toda resposta que chamou o Google traz `usage`.

## Busca e varredura

- Um local: uma chamada (Text Search, 20 por página). "Mais resultados" pede a página 2 e a 3 pelo token do Google (60 no máximo).
- Varredura: vários bairros, uma chamada por bairro (até 20), só a página 1 de cada. Antes, a tela mostra quantas chamadas vai gastar e o uso do dia e do mês; a API só aceita com `confirmCalls` igual ao número de locais. A mesma empresa em dois bairros aparece uma vez.
- Filtros (na resposta, não no Google): nota mínima exata (o Google só aceita passos de 0,5), avaliações mínimas, só com site, só em funcionamento. A lista de exclusão (redes já franqueadas) esconde quem tem o nome. A resposta diz quantos ficaram de fora e por quê, para a lista nunca parecer tudo o que o Google tinha.
- Cruzamento, só por `place_id` e telefone, na memória: "já é lead: dono X" (lead com o `place_id` ou o telefone; o vendedor vê a etiqueta mas só abre o lead se for dele), "já é cliente" (telefone ou WhatsApp de um cliente), "reservado por X", "contatado por X", "descartado", "pediu para não ser contatado", "várias unidades".

## Nota ICP

Calculada a cada resposta, nunca guardada (`icpScore` no shared). Pesos padrão: nota ≥ 4,5 +2 (≥ 4,2 +1); avaliações ≥ 500 +3 (≥ 200 +2, ≥ 50 +1); tem site +1; Instagram achado no site +1; mesmo nome em mais de um endereço da resposta +2. A lista vem da maior nota para a menor. Quem muda pesos e lista de exclusão: Gerente Comercial e Admin Master (Ajustes, `PUT /prospecting/settings/icp`); a auditoria guarda os pesos e a quantidade de nomes excluídos, não os nomes.

## Status de um prospect

`reservado`, `contatado`, `sem_interesse`, `nao_contatar`, `descartado` (com motivo) são do vendedor; `virou_lead` e `nao_encontrado` vêm das ações. Reservar uma empresa descartada ou "sem interesse" a assume; uma que outro segura responde 409 "Já reservado por X."; "pediu para não ser contatada" e "já virou lead" também são 409. Dois vendedores reservando ao mesmo tempo: um ganha (insert com `on conflict` e `for update`). O gerente transfere para quem tem `prospecting.use` e está ativo (`GET /prospecting/owners`). Abrir a ficha de uma empresa que o Google não conhece mais marca `nao_encontrado`, salvo quando ela já virou lead ou pediu para não ser contatada (esses ficam). Uma mudança de status ou de anotação, ou um "Criar lead", feita sobre um prospect que outro vendedor assumiu nesse meio-tempo responde 409.

## Enriquecer pelo site

Só no clique, um prospect por vez, lendo o site que o resultado ao vivo mostrou (a URL não é guardada):

- `robots.txt` primeiro (grupo `WingsSystem-Prospeccao`, senão `*`; a regra mais longa vale), e de novo para cada redirecionamento, no endereço para onde ele leva. Sem `robots.txt` (4xx) pode ler; erro 5xx ou sem resposta: não lê e diz por quê. As regras são comparadas sem expressão regular (o texto é do site), e um caminho com mais de 512 caracteres não é lido.
- No máximo 2 páginas: a do site e uma de contato ligada nela, no mesmo endereço ("contato", "fale conosco", "atendimento"). 5 segundos e 1 MB por página, user-agent `WingsSystem-Prospeccao/1.0`.
- Contra SSRF, o mesmo guarda de `apps/api/src/lib/public-probe.ts`: só http/https nas portas 80 e 443, o nome resolvido tem de dar só endereço público (checado de novo na conexão, contra DNS rebinding), cada redirecionamento (até 4) checado antes. Endereço bloqueado e endereço inexistente dão a mesma mensagem, para a tela não revelar quais nomes internos existem.
- Guarda em `prospects.enrichment` o primeiro Instagram, Facebook, LinkedIn, WhatsApp (`https://wa.me/<número>`) e e-mail achados, cada um com `source: 'site da empresa'` e a data.

## Criar lead

Depois do primeiro contato, com o que a empresa disse (não o que o Google mostra): empresa, contato, cargo, telefone ou e-mail, Instagram, observações e **"Aceitou receber WhatsApp?"** (obrigatório).

- Funil Formatação, na etapa de entrada **"Sem contato"** (o pedido dizia "Novo Contato", que é a primeira etapa da Expansão) ou na etapa escolhida do funil Formatação.
- Dono: o dono do prospect, fora do rodízio, sem tarefa de primeiro contato (o contato já houve) e sem a pesquisa paga da IA (`skipResearch`).
- Origem `google_places` ("Prospecção Google Maps"), `externalId` e `leads.google_place_id` = o `place_id`. O cargo vai para o contato (`crm_contacts.job_title`); as observações viram uma anotação do lead.
- Base legal: `consent` quando aceitou WhatsApp, `legitimate_interest` quando não; `consent_source = 'prospeccao'` e o texto "Aceitou / Não aceitou receber WhatsApp no primeiro contato (DD/MM/AAAA)." Quando o telefone ou o e-mail já é de uma negociação do próprio vendedor, o lead é juntado a ela (que mantém a origem) e a resposta de agora substitui a base legal que ela tinha.
- Telefone ou e-mail de um lead de outro vendedor: 409, como em "Criar negociação".

**WhatsApp sem aceite.** Um lead `google_places`, ou com `consent_source = 'prospeccao'` (a negociação em que o "Criar lead" foi juntado), sem base `consent` não recebe nada do número do sistema: mensagem, modelo, pedido de ligação e ligação respondem **403** `whatsapp_no_opt_in` (`leadOptInMissing` em `whatsapp/official-number.ts`, no `send` de `whatsapp/routes.ts` e em `POST /leads/:id/whatsapp/calls`). A ficha do lead desabilita os botões de WhatsApp com o motivo; ligar pelo telefone e e-mail continuam. As automações do CRM não mandam WhatsApp, e a Sofia só responde a quem escreveu primeiro.

No card do lead, "Dados do Google (ao vivo)" carrega a ficha no clique (gasta 1 ficha do mês).

## Rotas (todas com `prospecting.use`, salvo indicação)

| Rota                                        | O quê                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /prospecting/status`                   | `{ configured, aiConfigured }`, nunca a chave                               |
| `GET /prospecting/usage`                    | uso do dia e do mês                                                         |
| `GET /prospecting/owners`                   | quem pode receber um prospect (o vendedor vê só a si)                       |
| `GET /prospecting/settings`                 | pesos ICP, lista de exclusão, cota                                          |
| `PUT /prospecting/settings/icp`             | `prospecting.configure`                                                     |
| `PUT /prospecting/settings/quota`           | `prospecting.quota`                                                         |
| `POST /prospecting/parse`                   | frase → parâmetros (Haiku 4.5, OpenRouter, sem coleta de dados); 503 sem IA |
| `POST /prospecting/search`                  | busca ou varredura (503 sem chave, 429 cota, 502 Google)                    |
| `GET /prospecting/prospects?status=&owner=` | os prospects (só os nossos dados)                                           |
| `POST /prospecting/prospects`               | reservar ou descartar um resultado                                          |
| `PATCH /prospecting/prospects/:id`          | status, motivo, observações; dono só o gerente                              |
| `GET /prospecting/prospects/:id/place`      | ficha ao vivo (1 ficha)                                                     |
| `GET /prospecting/leads/:leadId/place`      | ficha ao vivo do lead que veio da prospecção (1 ficha)                      |
| `POST /prospecting/prospects/:id/enrich`    | lê o site da empresa                                                        |
| `POST /prospecting/prospects/:id/lead`      | cria o lead; também `leads.write`                                           |

Auditoria (só ids, status e contagens): `prospect.reserved`, `prospect.discarded`, `prospect.status_changed`, `prospect.transferred`, `prospect.not_found`, `prospect.enriched`, `prospect.converted`, `prospecting.icp_changed`, `prospecting.quota_changed`.

## Dados

- `prospects`: `place_id` (único por tenant), status, dono, motivo, observações, `enrichment`, `lead_id`, quem criou, datas.
- `prospect_calls`: uma linha por reserva de chamadas (quem, tipo `search`/`details`, segmento e locais que o vendedor digitou, quantas), só inserção.
- `prospecting_settings`: uma linha por tenant com `{ icp, quota }`; sem linha, os padrões.
- `leads.google_place_id`.
- Sem GRANT para `wings_ro` por enquanto (não precisa para a tela); fazer por migração se um dia o painel ou o `wings-staging-sql` precisarem.

## Configurar (Coolify)

1. No Google Cloud, ativar a **Places API (New)** e criar uma chave restrita a essa API e ao IP do servidor. A chave nunca vai para o web.
2. Criar `GOOGLE_PLACES_API_KEY` no app `wings-api` do **staging** primeiro (Coolify → Environment Variables) e reiniciar o app. Conferir na tela: some o "— Chave do Google não configurada.".
3. A IA da frase usa a mesma `OPENROUTER_API_KEY` dos outros agentes; sem ela o formulário funciona sozinho.

## Não verificado

- Nenhuma resposta real da Places API foi chamada daqui: os formatos (campos, `nextPageToken`, erros `NOT_FOUND`, `RESOURCE_EXHAUSTED`, `API_KEY_INVALID`) seguem a documentação do Google, e os testes usam respostas inventadas com esse formato (`fake-places-api.ts`). Na primeira busca real no staging, conferir nome, endereço, telefone, nota, página 2 e o link do Maps.
- O leitor de site real (`requestPage`) não roda nos testes (a rede é bloqueada); os testes passam por um transporte simulado.
