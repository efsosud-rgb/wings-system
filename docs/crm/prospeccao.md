# CRM Vendas → Prospecção (26/10/2026)

Branch `feat/crm-prospeccao`, migração **0097** `prospecting` (renumerar no merge se outra entrar antes). Pedido do Eric de 24/10: o vendedor de Formatação acha empresas no Google Maps, separa as boas, enriquece pelo site da própria empresa e, depois do primeiro contato, leva a empresa ao funil Formatação como lead.

Ampliado em 26/10 na branch `feat/maps-prospecting` (PR empilhado sobre o desta tela), pedido do Eric "Wings Maps Prospecting": filtro "só com telefone", registros incompletos, possível duplicidade, reserva em lote com revisão, histórico, números, exportação, retorno agendado no "Criar lead" e sugestão de abordagem pela IA. Sem migração nova: as tabelas abaixo bastam.

Tela: `/crm-vendas/prospeccao` (menu CRM Vendas → Prospecção). Código: `apps/api/src/modules/prospecting/`, contrato em `packages/shared/src/prospecting.ts`, tela em `apps/web/src/pages/crm/ProspectingPage.tsx`, painel do lead em `apps/web/src/pages/crm/GooglePlacePanel.tsx`.

**Prospecção Instagram**: [`docs/prospeccao/instagram.md`](../prospeccao/instagram.md). A parte 2 (comentários colados, aba Instagram desta tela) foi construída e está desligada: [`instagram-fase-a.md`](../prospeccao/instagram-fase-a.md). A parte 3 (Business Discovery na nota de 0 a 100 desta busca) foi construída e está desligada: [`instagram-fase-b.md`](../prospeccao/instagram-fase-b.md).

## Regras do Google (Maps Platform) e como são cumpridas

- **Só o `place_id` é guardado.** Nome, endereço, telefone, site, nota, avaliações, horário, tipos e link do Maps vêm ao vivo em cada resposta e não entram em tabela, log, auditoria nem linha do tempo do lead. As tabelas novas não têm coluna com esses nomes, e um teste (`prospecting.test.ts`) falha se uma aparecer; outro teste busca, reserva, abre a ficha, cria o lead e confere que nada do Google ficou no banco.
- **Ao vivo.** A busca e a ficha chamam o Google a cada clique; a tela guarda o resultado só na memória da página (nada no navegador). "Meus prospects" mostra só os nossos dados (status, dono, motivo, observações, o que o site mostrou); o nome e os contatos aparecem ao abrir a ficha.
- **Atribuição** (corrigida em 29/10). Dados do Places sem um mapa do Google pedem o **logo oficial "Google Maps"** ([política do Places API (New)](https://developers.google.com/maps/documentation/places/web-service/policies)): 16 a 19 px de altura, 10 px livres dos lados e em cima e 5 embaixo, a versão sem contorno em fundo liso, rótulo de acessibilidade "Google Maps", sem nenhuma alteração. O arquivo é o do próprio Google, sem mudança: `apps/web/public/google/GoogleMaps_Logo_Gray.svg`, tirado de `Google_Maps_Attribution_Assets.zip` (link "Download the Google Maps attribution assets" dessa página). `GoogleMapsLogo` (em `GooglePlacePanel.tsx`) mostra o logo com 18 px no topo do bloco de resultados ("Dados: [logo] consultados agora e não guardados.") e na ficha (cartão do lead e cartão do prospect). A lista continua com o título "Resultados do Google Maps" e cada empresa com "Abrir no Google Maps" (o `googleMapsUri` da resposta). O texto "Google Maps" só vale onde o logo não couber (hoje, nenhum lugar). Nenhum outro mapa.
- **Nada do Google vai para IA.** A IA só transforma a frase do vendedor ("hamburguerias em Icaraí com nota 4,5+") em parâmetros (segmento, locais, nota mínima, avaliações mínimas, só com site). Ela nunca busca: o vendedor clica em "Usar no formulário" e depois em Buscar. Teto: 60 frases por pessoa por dia (**429** `parse_quota`), contadas no log de auditoria `prospect.query_parsed`, gravado antes da chamada e sem o texto.
- **Chave só no servidor.** `GOOGLE_PLACES_API_KEY` vai no cabeçalho `X-Goog-Api-Key`, nunca numa URL, num log ou numa resposta. Sem ela, toda rota que chama o Google responde **503** `places_not_configured` ("Chave do Google não configurada.") e a tela mostra "— Chave do Google não configurada." antes de qualquer busca (`GET /prospecting/status`).
- Erro do Google: o log leva só o código e o status HTTP; a tela recebe 502 com "O Google não respondeu agora…" ou "O Google recusou a chave…". Nenhuma chamada é repetida (pode ter sido cobrada). Numa varredura, um bairro que falha não derruba os outros (desde 29/10): a resposta traz os resultados dos bairros que responderam e `failedPlaces` (bairro e código do erro), e a tela mostra "X de Y locais não responderam: Ingá (o Google demorou demais). As chamadas contaram na cota." Só quando todos falham é o 502 de antes. A cota conta todas as chamadas feitas, as que falharam também.

## Quem vê o quê

| Nível               | `prospecting.use`                     | `prospecting.configure` | `prospecting.quota` | Criar lead              |
| ------------------- | ------------------------------------- | ----------------------- | ------------------- | ----------------------- |
| Vendedor Formatação | own: os seus; o que outro segura some | —                       | —                   | sim (só dos seus)       |
| Gerente Comercial   | all: todos, com etiqueta; transfere   | sim                     | —                   | sim                     |
| Diretoria           | all                                   | —                       | —                   | não (sem `leads.write`) |
| Admin Master        | all                                   | sim                     | sim                 | sim                     |
| Vendedor Expansão   | — (403 em toda rota)                  | —                       | —                   | —                       |

`prospecting.export` (planilha): Gerente Comercial e Admin Master. Histórico e Números seguem o `prospecting.use`: o vendedor vê os seus, o gerente, a Diretoria e o Admin veem todos.

Um prospect fora do alcance responde 404. "Segurar" é estar `reservado` ou `contatado`: o vendedor não vê na busca a empresa que outro segura (conta em "ocultos"); o gerente vê com "reservado por X".

## Prazos: reserva que expira e dados do site (29/10)

- **Reserva que expira.** Um prospect `reservado` sem atualização há **30 dias** (padrão) e um `contatado` sem atualização há **90 dias** voltam a ficar livres: viram `descartado` com o motivo "Reserva expirada em DD/MM/AAAA". A linha, o dono e as observações ficam; outro vendedor passa a ver a empresa na busca e pode reservá-la (`descartado` não segura, `PROSPECT_HOLDING_STATUSES`). Cada expiração grava `prospect.reservation_expired` (id, status anterior, prazo). "Atualização" é qualquer mudança no prospect (status, motivo, observações, dono, enriquecimento). O cartão em "Meus prospects" mostra "a reserva expira em X dias".
- **Dados do site.** O `enrichment` (e-mail e links achados no site da empresa) de um prospect que **não virou lead** e ficou **180 dias** sem atualização é apagado (vira `{}`); a linha e o resto ficam. A auditoria guarda só a contagem (`prospecting.enrichment_cleared`, `{ count, days }`). **O padrão de 180 dias está a validar com o advogado.**
- **Onde mudar.** Ajustes → Prazos (`PUT /prospecting/settings/retention`, `prospecting.configure`, como os pesos ICP), auditado como `prospecting.retention_changed` com o antes e o depois. Faixas: reserva e contatado de 7 a 365 dias, dados do site de 30 a 730. Ficam em `prospecting_settings.settings.retention`, sem migração.
- **Quando roda.** Na própria API (`apps/api/src/modules/prospecting/retention.ts`), ao subir e a cada 6 horas, sob uma trava (`pg_try_advisory_xact_lock`): com duas réplicas, uma só faz o trabalho. Não chama o Google.

## Cota de chamadas

Cada chamada ao Google conta 1. Padrão: **40 por pessoa por dia** e, para a empresa toda, **950 buscas e 950 fichas por mês** (dentro das 1.000 grátis de cada tipo). Dia e mês viram à meia-noite de São Paulo. Quem muda: Admin Master em Ajustes (`PUT /prospecting/settings/quota`, máximo 1.000 por mês).

As chamadas são reservadas antes de ir ao Google, numa transação com trava (`prospect_calls`, só inserção): ou cabem todas ou nenhuma vai. Uma chamada que falhou continua contada. Recusa: **429** `prospecting_quota` com a frase ("Você já usou as 40 chamadas ao Google de hoje…", "O mês chegou a 950 buscas…", "A varredura gasta N chamadas e só restam M hoje."). Toda resposta que chamou o Google traz `usage`.

## Busca e varredura

- Um local: uma chamada (Text Search, 20 por página). "Mais resultados" pede a página 2 e a 3 pelo token do Google (60 no máximo).
- Varredura: vários bairros, uma chamada por bairro (até 20), só a página 1 de cada. Antes, a tela mostra quantas chamadas vai gastar e o uso do dia e do mês; a API só aceita com `confirmCalls` igual ao número de locais. A mesma empresa em dois bairros aparece uma vez.
- Filtros (na resposta, não no Google): nota mínima exata (o Google só aceita passos de 0,5), avaliações mínimas, só com site, só com telefone, só em funcionamento. A lista de exclusão (redes já franqueadas) esconde quem tem o nome. A resposta diz quantos ficaram de fora e por quê, para a lista nunca parecer tudo o que o Google tinha.
- Cruzamento, só por `place_id` e telefone, na memória: "já é lead: dono X" (lead com o `place_id` ou o telefone; o vendedor vê a etiqueta mas só abre o lead se for dele), "já é cliente" (telefone ou WhatsApp de um cliente), "reservado por X", "contatado por X", "descartado", "pediu para não ser contatado", "várias unidades".

- **Incompleto.** Cada resultado diz o que o Google não deu (`missing`: sem telefone, sem site, sem endereço, sem nota). Nada é completado nem inventado; sem nota, a nota ICP não conta os pontos de nota.
- **Possível duplicidade, nunca juntada.** Dois resultados com o mesmo telefone ganham "possível duplicidade: mesmo telefone"; um resultado cujo domínio do site é o de uma negociação (`leads.website`, comparado sem `www`, caminho nem maiúsculas) ganha "possível lead: mesmo site de uma negociação". Perfis e páginas que não são o site da empresa (Instagram, Facebook, Linktree, wa.me, iFood…) nunca marcam duplicidade (`siteDomain` no shared). Nomes parecidos só dão "várias unidades". A pessoa decide; o sistema não une empresas.
- Não há busca por raio: a Text Search só aceita raio com coordenadas (latitude e longitude), e a tela não tem mapa para escolher o centro. Use a cidade ou a lista de bairros.
- Não há mapa interativo: os termos do Google proíbem mostrar os dados do Places sobre outro mapa, e um mapa do Google no navegador pede uma chave pública própria (Maps JavaScript API). Cada empresa tem "Abrir no Google Maps".

## Reserva em lote (revisão antes)

Na lista, a caixa de cada empresa livre (ou descartada, ou "sem interesse") entra na seleção; "Selecionar todas livres" marca todas. "Revisar N selecionadas" mostra nome, nota ICP, o que falta e as etiquetas; só "Reservar N" chama a API (`POST /prospecting/prospects/batch`, até 60). Cada empresa é reservada sozinha, com as mesmas regras do clique (transação, `for update`): uma recusa não desfaz as outras, e a resposta diz, empresa por empresa, o que entrou e por quê não ("Já reservado por X.", "A empresa pediu para não ser contatada."). Cada reserva grava `prospect.reserved` com `batch: true`.

Reservar não cria lead: guarda o `place_id` em Meus prospects. O lead só nasce depois do primeiro contato, em "Criar lead", e leva só o que o vendedor digitou no formulário (ver "Criar lead"): os termos do Google não deixam copiar nome, telefone ou endereço do Maps para o CRM.

## Histórico, Números e planilha

- **Histórico** (`GET /prospecting/history`, as últimas 50): data, quem, segmento e locais como foram digitados, chamadas gastas. "Usar no formulário" devolve a busca ao formulário; só "Buscar" chama o Google de novo (o resultado antigo não fica guardado).
- **Números** (`GET /prospecting/metrics`): prospects por dono e situação, quantos viraram lead e as chamadas ao Google no mês de cada um.
- **Planilha** (`GET /prospecting/prospects/export.csv`, `prospecting.export`, até 5.000 linhas, filtros de situação e dono): situação, dono, motivo, observações, o que o site da empresa mostrou, a negociação, o `place_id`, datas. Nunca o nome, endereço, telefone, site ou nota do Google (não estão guardados). Célula que começa com `=`, `+`, `-` ou `@` sai como texto. Auditoria `prospecting.exported` com a quantidade de linhas e os filtros usados.

## Sugestão de abordagem (IA)

Em Meus prospects, "Sugerir abordagem (IA)" (`POST /prospecting/prospects/:id/approach`): o vendedor escolhe o canal (ligação, e-mail ou visita; **nunca WhatsApp**, porque antes do primeiro contato não há aceite), o segmento e o que sabe da empresa; a IA (Haiku 4.5 pelo OpenRouter, sem coleta de dados) devolve abertura, pontos da conversa e próximo passo, marcados "Sugestão da IA — revise antes de usar". A IA recebe só isso e quais tipos de contato o site da empresa mostrou (os nomes, não os valores); nada do Google, nenhum telefone, e-mail ou nome. Nada é enviado à empresa: o vendedor copia e usa. Recusas: 503 sem IA, 409 para quem pediu para não ser contatado, 429 depois de 30 por pessoa por dia (contadas no log de auditoria `prospect.approach_suggested`, gravado antes da chamada).

**E a Sofia?** A Sofia só responde a quem escreveu primeiro no WhatsApp (`docs/whatsapp/sofia.md`) e não puxa contato ativo; isso não mudou. Um lead da prospecção que escrever no WhatsApp cai na regra 1 da Sofia (negociação aberta com dono → vai direto ao vendedor). A sugestão de abordagem acima é o apoio ao vendedor no primeiro contato; nenhuma campanha ou disparo foi criado.

## Nota ICP

Calculada a cada resposta, nunca guardada (`icpScore` e `withInstagram` no shared), **de 0 a 100**: `round(100 × pontos obtidos ÷ pontos possíveis)`. Pesos padrão do Google: nota ≥ 4,5 +2 (≥ 4,2 +1); avaliações ≥ 500 +3 (≥ 200 +2, ≥ 50 +1); tem site +1; Instagram achado no site +1; mesmo nome em mais de um endereço da resposta +2 (9 pontos possíveis: numa faixa exclusiva conta só o maior peso). Com a Business Discovery ligada, a parte do Instagram entra só com os critérios que a Meta deu ([instagram-fase-b.md](../prospeccao/instagram-fase-b.md)). A lista vem da maior nota para a menor. Quem muda pesos e lista de exclusão: Gerente Comercial e Admin Master (Ajustes, `PUT /prospecting/settings/icp`); a auditoria guarda os pesos e a quantidade de nomes excluídos, não os nomes.

## Status de um prospect

`reservado`, `contatado`, `sem_interesse`, `nao_contatar`, `descartado` (com motivo) são do vendedor; `virou_lead` e `nao_encontrado` vêm das ações. Reservar uma empresa descartada ou "sem interesse" a assume; uma que outro segura responde 409 "Já reservado por X."; "pediu para não ser contatada" e "já virou lead" também são 409. Dois vendedores reservando ao mesmo tempo: um ganha (insert com `on conflict` e `for update`). O gerente transfere para quem tem `prospecting.use` e está ativo (`GET /prospecting/owners`). Marcar `nao_contatar` grava também o "não me contate" único em todos os canais, pelo `place_id` e pelo lead ligado ([nao-me-contate.md](nao-me-contate.md)); a busca mostra o selo "não me contate" na empresa cujo `place_id` ou telefone está no cadastro. Abrir a ficha de uma empresa que o Google não conhece mais marca `nao_encontrado`, salvo quando ela já virou lead ou pediu para não ser contatada (esses ficam). Uma mudança de status ou de anotação, ou um "Criar lead", feita sobre um prospect que outro vendedor assumiu nesse meio-tempo responde 409.

## Enriquecer pelo site

Só no clique, um prospect por vez, lendo o site que o resultado ao vivo mostrou (a URL não é guardada):

- `robots.txt` primeiro (grupo `WingsSystem-Prospeccao`, senão `*`; a regra mais longa vale), e de novo para cada redirecionamento, no endereço para onde ele leva. Sem `robots.txt` (4xx) pode ler; erro 5xx ou sem resposta: não lê e diz por quê. As regras são comparadas sem expressão regular (o texto é do site), e um caminho com mais de 512 caracteres não é lido.
- No máximo 3 páginas: a do site (o rodapé faz parte dela), uma de contato e uma de "sobre"/"quem somos" ligadas nela, no mesmo endereço. 12 segundos e 1 MB por página, com **1 nova tentativa** depois de estouro de tempo ou falha de conexão (nunca depois de uma resposta, como 404 ou 503), e 40 segundos no total por empresa (t086: com 5 segundos e sem nova tentativa, o site "não respondia" e o Instagram nunca vinha), user-agent `WingsSystem-Prospeccao/1.0`.
- Contra SSRF, o mesmo guarda de `apps/api/src/lib/public-probe.ts`: só http/https nas portas 80 e 443, o nome resolvido tem de dar só endereço público (checado de novo na conexão, contra DNS rebinding), cada redirecionamento (até 4) checado antes. Endereço bloqueado e endereço inexistente dão a mesma mensagem, para a tela não revelar quais nomes internos existem.
- Guarda em `prospects.enrichment` o primeiro Instagram, Facebook, LinkedIn, WhatsApp (`https://wa.me/<número>`) e e-mail achados, cada um com `source: 'site da empresa'` e a data.

## Instagram da empresa na busca (t086, 04/11/2026)

Cada empresa da busca sem Instagram conhecido ganha, **sozinha e logo depois da busca** (a tela chama `POST /prospecting/instagram/find`, 5 empresas por vez), uma procura em três caminhos, parando no primeiro que resolve:

1. **Site da empresa** (o que o Google deu): home, contato e "sobre", 12 s com 1 nova tentativa, redirecionamentos seguidos, robots.txt obedecido. Procura links `instagram.com/<@>` em todas as páginas lidas.
2. **Meta Business Discovery** (API oficial, a mesma da coluna Instagram): testa o @ provável (a palavra do domínio próprio do site, só se ela trouxer ao menos uma palavra que identifica o nome; depois o nome da empresa junto, sem acento) e só guarda se a Meta confirmar uma conta comercial. Mostra seguidores/posts com "Meta, lido em DD/MM". **Nunca palpite a partir de app de entrega, marketplace ou agenda (Rappi, Uber Eats, Anota AI, Doctoralia, Shopee…) nem de subdomínio (`pedido.`, `loja.`)**: esses endereços não são o site da empresa. Origem exibida: "palpite pelo nome, conta confirmada na Meta".
3. **Busca na web** (Brave, `BRAVE_SEARCH_API_KEY`, o provedor do worker): "nome + cidade + instagram". Um perfil só passa se **todas as palavras que identificam o nome** estão no @ ou no título; depois é confirmado na Meta (origem "busca na web, conta confirmada na Meta"). Com a Meta desligada, fica "busca na web, não confirmada na Meta", para o vendedor conferir. Teto de **100 buscas por dia** para a empresa toda (reservadas sob trava, `audit_log` `prospect.web_search`) **e** o gasto entra no mesmo razão do enriquecimento (`lead_enrichment_ledger`, passo `web_search`, sem lead) e no mesmo teto em dólar, `ENRICH_DAILY_USD`: um número só para o worker e para esta busca (decisão do Eric, 04/11/2026). Sem a chave, o caminho é pulado, o motivo diz isso e nada é gasto.

- **Sem Instagram em nenhum caminho:** "—" e o motivo de cada caminho ("Site: Página inicial: o site não respondeu em 12 segundos (2 tentativas).", "Meta: conta não confirmada…", "Web: nenhum perfil… bate com o nome"). Nunca um @ inventado.
- **Cota e cache por empresa** (`prospect_instagram_lookups`, migração 0112, só o `place_id`, o @ achado ou os motivos; nunca nome, endereço, telefone nem site do Google): uma empresa não é lida, consultada nem buscada de novo até a data de nova tentativa: **30 dias** com @ achado, **1 dia** se o site não respondeu, **6 horas** se a Meta pediu espera/recusou ou a busca falhou (resposta ilegível do Brave incluída: é falha, nunca "nenhum perfil"), **7 dias** nos demais. A Meta respeita o teto do dia e a espera de sempre (`instagram_discovery_calls`); o Google não é chamado. Apagado pela faxina de hora em hora quando vence.
- **Quem pode:** o tíquete (`instagramFind`) vem assinado na resposta da busca, por vendedor, 12 h, e leva o nome, o site e o endereço da empresa; a rota não aceita dado da tela. Tíquete errado, de outro vendedor ou vencido recusa o pedido inteiro (400 `find_ticket_invalid`) antes de ler, consultar ou buscar qualquer coisa. Empresa com "não me contate" não ganha tíquete.
- **Botão Enriquecer** também usa o tíquete (o campo `enrichTicket` do item, que continua na linha depois que o finder responde; o `instagramFind` some): lê o site **do tíquete** (o site digitado pela pessoa só entra quando o tíquete não tem um, para um endereço digitado não pôr um @ no cache que os outros vendedores leem) e, sem link, tenta a Meta e a web; o @ achado vai para `enrichment.instagram` com a origem, e as buscas seguintes mostram essa mesma origem (um palpite continua palpite; só "site da empresa" dá o ponto de Instagram na nota); sem @, a tela diz o motivo de cada caminho.
- Auditoria: `prospect.instagram_find` (empresas, achadas), só contagens.
- **Não verificado ao vivo:** a resposta do Brave e a Meta seguem a referência (o log guarda só o formato).

## Criar lead

O modal abre com o que é **nosso**: E-mail e Instagram que o site da empresa mostrou (ou o @ da linha da busca, só quando esse @ também veio do site da empresa: o @ tirado do campo "site" do Google, fonte `'site no Google'`, é dado do Google e não entra no formulário nem no lead). **Empresa, Telefone e Site começam em branco**: o vendedor digita o que a empresa confirmou no contato. Os dados do Google (nome, telefone, site) aparecem numa linha de consulta no alto do modal ("consultado agora no Google Maps e não salvo"), vindos da resposta ao vivo que a tela tem na memória, e não vão para o formulário. Em Meus prospects, a linha de consulta só aparece se a ficha já foi aberta (abrir o modal não gasta ficha). O vendedor acrescenta contato, cargo, observações e **"Aceitou receber WhatsApp?"** (obrigatório).

**O que o servidor guarda.** Só o que o vendedor digitou ou confirmou (empresa, telefone, e-mail, Instagram, site vão para o lead e aparecem no card Origem como em qualquer lead). O servidor não recebe a linha do Google e a regra "só o `place_id`" continua inteira, nas tabelas da prospecção e no lead. Um teste de tela (`ProspectingPage.test.tsx`, "without Google's name…", e outro para o @ da fonte `'site no Google'`) envia o formulário sem editar os campos do Google e confere que nenhum valor do Google vai no `POST`; `prospectLeadDefaults` tem outro, no shared.

**Pré-preenchimento com o Google: pronto e desligado (t087, 04/11).** Pedido do Eric: abrir o modal já com Empresa, Telefone e Site do Maps. Fica desligado até o Eric decidir (e o advogado confirmar que os termos da Maps Platform aceitam o dado confirmado pelo vendedor no CRM), porque o vendedor que salva sem editar passaria a gravar dado do Maps no lead. Para ligar: `PROSPECT_LEAD_PREFILL_FROM_GOOGLE = true` em `packages/shared/src/prospecting.ts`, a decisão em `docs/decisoes.md`, a regra da linha "Só o `place_id` é guardado" e o texto "não guardados" reescritos ("na prospecção só o `place_id`; no lead, o que o vendedor confirmou"), e os testes "nothing from Google is stored" (`prospecting.test.ts`) e o de tela acima passando a enviar exatamente o que a tela preenche.

- Funil Formatação, na etapa **"Sem contato"** (já escolhida no campo Etapa; o servidor cria a etapa se o funil ainda não a tem, nunca cai na primeira etapa por acaso; se alguém deixar "Sem contato" inativa, o servidor usa a primeira etapa ativa do funil, então não a desative) ou na etapa escolhida do funil Formatação.
- Dono: o dono do prospect, fora do rodízio, sem tarefa de primeiro contato (o contato já houve) e sem a pesquisa paga da IA (`skipResearch`).
- Origem `google_places` ("Prospecção Google Maps"), `externalId` e `leads.google_place_id` = o `place_id`. O cargo vai para o contato (`crm_contacts.job_title`); as observações viram uma anotação do lead.
- Base legal: `consent` quando aceitou WhatsApp, `legitimate_interest` quando não; `consent_source = 'prospeccao'` e o texto "Aceitou / Não aceitou receber WhatsApp no primeiro contato (DD/MM/AAAA). Empresa encontrada no Google Maps em DD/MM/AAAA." (a data em que o prospect foi reservado) Quando o telefone ou o e-mail já é de uma negociação do dono do prospect, o lead é juntado a ela (que mantém a origem); se é de outra pessoa, responde 409 "Já existe uma negociação com este telefone ou e-mail.", qualquer que seja o nível de quem clica (gerente e Admin inclusive). Na junção, a resposta de agora substitui uma base legal vinda da prospecção ou nenhuma. Diante de um `consent` de outra origem (um formulário, por exemplo): um "sim" **mantém** esse consentimento e a resposta vira uma anotação no lead; um "não" **substitui** esse consentimento pela base da prospecção (`legitimate_interest`, `prospeccao`, texto "Não aceitou…"), o que bloqueia o WhatsApp, e a anotação registra a origem e a data do consentimento substituído (decisão do Eric, 28/10: o "não" explícito mais recente vale mais).
- Telefone ou e-mail de um lead de outro vendedor: 409, como em "Criar negociação".
- **Retorno combinado** (opcional): data e hora que a empresa pediu. Vira uma tarefa de follow-up "Retorno combinado na prospecção" para o dono do lead, pelo serviço de tarefas do CRM (`createTask`, que grava `lead.task_created` na linha do tempo).
- **Sem retorno combinado**, um lead **novo** ganha mesmo assim a tarefa "Primeiro retorno da prospecção", para o dono, **24 horas** depois (`PROSPECT_DEFAULT_FOLLOW_UP_HOURS`). Lead juntado a uma negociação que já existia não ganha tarefa extra, e nenhuma das duas tarefas é aberta se o telefone, o e-mail ou o Instagram do lead tem "não me contate" (a auditoria `prospect.converted` diz em `followUpTask` se a tarefa foi aberta; `followUp` é só o retorno combinado).

**WhatsApp sem aceite.** Um lead `google_places`, ou com `consent_source = 'prospeccao'` (a negociação em que o "Criar lead" foi juntado), sem base `consent` não recebe nada do número do sistema: mensagem, modelo, pedido de ligação e ligação respondem **403** `whatsapp_no_opt_in` (`leadOptInMissing` em `whatsapp/official-number.ts`, no `send` de `whatsapp/routes.ts` e em `POST /leads/:id/whatsapp/calls`). A ficha do lead desabilita os botões de WhatsApp com o motivo; ligar pelo telefone e e-mail continuam. As automações do CRM não mandam WhatsApp. A regra também entra em `contactBlock` ([nao-me-contate.md](nao-me-contate.md)): o pedido automático de ligação não sai, e a Sofia não responde sozinha a um lead assim (a conversa espera um atendente).

No card do lead, "Dados do Google (ao vivo)" carrega a ficha no clique (gasta 1 ficha do mês).

## Rotas (todas com `prospecting.use`, salvo indicação)

| Rota                                        | O quê                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /prospecting/status`                   | `{ configured, aiConfigured }`, nunca a chave                               |
| `GET /prospecting/usage`                    | uso do dia e do mês                                                         |
| `GET /prospecting/owners`                   | quem pode receber um prospect (o vendedor vê só a si)                       |
| `GET /prospecting/settings`                 | pesos ICP, lista de exclusão, cota, prazos                                  |
| `PUT /prospecting/settings/icp`             | `prospecting.configure`                                                     |
| `PUT /prospecting/settings/quota`           | `prospecting.quota`                                                         |
| `PUT /prospecting/settings/retention`       | prazos de reserva e dos dados do site; `prospecting.configure`              |
| `POST /prospecting/parse`                   | frase → parâmetros (Haiku 4.5, OpenRouter, sem coleta de dados); 503 sem IA |
| `POST /prospecting/search`                  | busca ou varredura (503 sem chave, 429 cota, 502 Google)                    |
| `GET /prospecting/prospects?status=&owner=` | os prospects (só os nossos dados)                                           |
| `POST /prospecting/prospects`               | reservar ou descartar um resultado                                          |
| `PATCH /prospecting/prospects/:id`          | status, motivo, observações; dono só o gerente                              |
| `GET /prospecting/prospects/:id/place`      | ficha ao vivo (1 ficha)                                                     |
| `GET /prospecting/leads/:leadId/place`      | ficha ao vivo do lead que veio da prospecção (1 ficha)                      |
| `POST /prospecting/prospects/:id/enrich`    | lê o site da empresa                                                        |
| `POST /prospecting/prospects/:id/lead`      | cria o lead (e a tarefa de follow-up); também `leads.write`                 |
| `POST /prospecting/prospects/batch`         | reserva em lote, resultado por empresa                                      |
| `GET /prospecting/history`                  | buscas feitas (o que foi digitado)                                          |
| `GET /prospecting/metrics`                  | prospects por dono e situação, chamadas no mês                              |
| `GET /prospecting/prospects/export.csv`     | planilha só com dados da Wings; `prospecting.export`                        |
| `POST /prospecting/prospects/:id/approach`  | sugestão de abordagem da IA; nada é enviado                                 |

Auditoria (só ids, status e contagens): `prospect.reserved`, `prospect.discarded`, `prospect.status_changed`, `prospect.transferred`, `prospect.not_found`, `prospect.enriched`, `prospect.converted`, `prospecting.icp_changed`, `prospecting.quota_changed`, `prospecting.retention_changed`, `prospect.reservation_expired`, `prospecting.enrichment_cleared` (só a contagem), `prospecting.exported`, `prospect.approach_suggested`, `prospect.query_parsed`; `prospect.reserved` leva `batch: true` quando veio do lote e `prospect.converted` leva `followUp`.

## Dados

- `prospects`: `place_id` (único por tenant), status, dono, motivo, observações, `enrichment`, `lead_id`, quem criou, datas.
- `prospect_calls`: uma linha por reserva de chamadas (quem, tipo `search`/`details`, segmento e locais que o vendedor digitou, quantas), só inserção.
- `prospecting_settings`: uma linha por tenant com `{ icp, quota, retention }`; sem linha (ou parte), os padrões.
- `leads.google_place_id`.
- Sem GRANT para `wings_ro` por enquanto (não precisa para a tela); fazer por migração se um dia o painel ou o `wings-staging-sql` precisarem.

## Configurar (Coolify)

Enquanto a chave não existe, a tela mostra "— Conexão com o Google pendente: a chave ainda não foi configurada no servidor." e o botão Buscar fica desligado; nenhuma lista de exemplo aparece. Histórico, Números, Meus prospects e a sugestão de abordagem funcionam sem a chave (não chamam o Google).

1. No Google Cloud, ativar a **Places API (New)** e criar uma chave restrita a essa API e ao IP do servidor. A chave nunca vai para o web.
2. Criar `GOOGLE_PLACES_API_KEY` no app `wings-api` do **staging** primeiro (Coolify → Environment Variables) e reiniciar o app. Conferir na tela: some o "— Chave do Google não configurada.".
3. A IA da frase usa a mesma `OPENROUTER_API_KEY` dos outros agentes; sem ela o formulário funciona sozinho.

## Não verificado

- O custo: a tela diz "Custo estimado: R$ 0 enquanto o mês ficar dentro da cota", porque a cota trava em 1.000 por tipo e a documentação do Google dá 1.000 grátis por mês nos SKUs Enterprise (os campos telefone, site e nota). Conferir no faturamento do Google Cloud no primeiro mês.
- A sugestão de abordagem e a reserva em lote só rodaram com IA e Google simulados.
- O logo foi conferido contra o texto da política do Google, não por uma revisão do Google; a falha de um bairro só rodou com o Google simulado (tempo esgotado).

- Nenhuma resposta real da Places API foi chamada daqui: os formatos (campos, `nextPageToken`, erros `NOT_FOUND`, `RESOURCE_EXHAUSTED`, `API_KEY_INVALID`) seguem a documentação do Google, e os testes usam respostas inventadas com esse formato (`fake-places-api.ts`). Na primeira busca real no staging, conferir nome, endereço, telefone, nota, página 2 e o link do Maps.
- O leitor de site real (`requestPage`) não roda nos testes (a rede é bloqueada); os testes passam por um transporte simulado.
