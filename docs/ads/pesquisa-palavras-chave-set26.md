# Pesquisa de palavras-chave — Formatação de franquias (set/2026)

Leitura em 28/09/2026 na conta Google Ads 4268586278, **só leitura**. Nada foi criado nem alterado.

## O Planejador de palavras-chave não respondeu: o token é *Explorer*

`KeywordPlanIdeaService` (`generateKeywordIdeas` e `generateKeywordHistoricalMetrics`) recusou as duas chamadas com `DEVELOPER_TOKEN_NOT_APPROVED`: *"This method is not allowed for use with explorer access. Please apply for basic or standard access."* (requestId `9pauI_zDbZ8s44tUL5-VMg`). O nível **Explorer** do developer token só permite leitura de relatórios e escrita na própria conta; volume de buscas por região, concorrência e lance de topo de página do Planejador exigem **Basic access**.

**O que destrava:** no Google Ads, na conta administrador que é dona do developer token (`GOOGLE_ADS_LOGIN_CUSTOMER_ID`), Ferramentas → Central de API → "Solicitar acesso Basic" (formulário curto: uso interno, uma conta, sem revenda; costuma sair em 1 a 3 dias úteis). Assim que aprovar, o script está pronto e a tabela abaixo é substituída pela do Planejador (top 40 por volume no RJ, com buscas/mês RJ e Brasil, concorrência e lance mín–máx), a partir das sementes:

`formatação de franquias`, `formatar franquia`, `consultoria de franquias`, `como franquear minha empresa`, `transformar negócio em franquia`, `franqueadora`, `consultoria empresarial`, `mentoria de negócios`, `organizar empresa`, `expandir negócio`, `consultoria de negócios`, `gestão empresarial` — idioma `languageConstants/1014` (português), geos `geoTargetConstants/20102` (State of Rio de Janeiro) e `geoTargetConstants/2076` (Brasil), rede `GOOGLE_SEARCH`.

## O que dá para ler hoje: as palavras-chave da própria conta, 2026-06-30 a 2026-09-28

Fonte `keyword_view` (relatório, permitido ao Explorer). **Impressões não são volume de busca**: dependem da verba, da segmentação (as campanhas antigas cobrem o Brasil; a de set/26, só RJ) e do lance. Servem para ver *o que já pagou* e *o que só trouxe curiosos*. Conversões são o `form_submit` da conta, contaminado por buscas de "google meu negócio" (ver `google-escrita.md`, 25/09); trate como indício, não como CPL. Estimativas de lance de topo de página (`position_estimates`) vieram vazias para estas palavras.

### Formatação de franquia (30)

| Palavra-chave | Corresp. | Impressões (90 d) | Cliques | Custo | Conv. | CPC médio | Campanha(s) |
|---|---|---:|---:|---:|---:|---:|---|
| consultoria de franchising | exata | 592 | 118 | R$ 645,01 | 10 | R$ 5,47 | Search - Wings - Geral |
| assessoria para franquias | frase | 143 | 28 | R$ 149,07 | 1 | R$ 5,32 | Search - Wings - Geral |
| como transformar meu negócio em franquia | exata | 17 | 1 | R$ 6,62 | 0 | R$ 6,62 | Search - Wings - Geral |
| como estruturar uma franquia | exata | 14 | 1 | R$ 16,80 | 0 | R$ 16,80 | Search - Wings - Geral |
| consultoria de franquia | frase | 12 | 0 | R$ 0,00 | 0 | — | Search - Wings - Geral |
| especialista em franchising | frase | 10 | 0 | R$ 0,00 | 0 | — | Search - Wings - Geral |
| wings franquias | frase | 10 | 0 | R$ 0,00 | 0 | — | Search - Wings - Geral |
| formatação de franquia | frase | 6 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| formatar franquia | exata | 4 | 1 | R$ 3,29 | 0 | R$ 3,29 | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| consultoria para franquias | exata | 1 | 0 | R$ 0,00 | 0 | — | Search - Wings - Geral |
| como franquear meu negócio | exata | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Franquear Negócio | Alta Intenção; SEARCH | Cauda Longa | Pro |
| como franquear meu negócio | frase | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Franquear Negócio | Alta Intenção; SEARCH | Cauda Longa | Pro |
| transformar empresa em franquia | frase | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Franquear Negócio | Alta Intenção; SEARCH | Cauda Longa | Pro |
| franquear meu negócio | exata | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Franquear Negócio | Alta Intenção; SEARCH | Cauda Longa | Pro |
| franquear meu negócio | frase | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Franquear Negócio | Alta Intenção; SEARCH | Cauda Longa | Pro |
| wings company franquias | frase | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Franquear Negócio | Alta Intenção; SEARCH | Marca | Wings Com |
| quanto custa franquear | frase | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| quanto custa franquear | exata | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| quanto custa formatar franquia | frase | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| quanto custa franquear empresa | exata | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| custo franquear empresa | frase | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| formatar franquia | frase | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| formatação de franquia | exata | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| franquear empresa | exata | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| franquear empresa | frase | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| consultoria franquia | frase | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| consultoria franchising | frase | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| consultoria franquia | exata | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| empresa de franchising | exata | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |
| empresa de franchising | frase | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Cauda Longa | Processo/Dúvida; SEARCH | Franquear Negócio | A |

### Consultoria e mentoria de negócios (1)

| Palavra-chave | Corresp. | Impressões (90 d) | Cliques | Custo | Conv. | CPC médio | Campanha(s) |
|---|---|---:|---:|---:|---:|---:|---|
| wings consultoria | frase | 17 | 2 | R$ 15,86 | 0 | R$ 7,93 | Search - Wings - Geral |

### Genérico ou fora do perfil (9)

| Palavra-chave | Corresp. | Impressões (90 d) | Cliques | Custo | Conv. | CPC médio | Campanha(s) |
|---|---|---:|---:|---:|---:|---:|---|
| como crescer minha empresa | exata | 2219 | 193 | R$ 1.211,22 | 19 | R$ 6,28 | Search - Wings - Geral |
| wings company | exata | 204 | 60 | R$ 91,70 | 0 | R$ 1,53 | SEARCH | Marca | Wings Company; SEARCH | Geral; SEARCH | Formatação |  |
| como expandir meu negócio | exata | 53 | 1 | R$ 12,55 | 0 | R$ 12,55 | Search - Wings - Geral |
| escalar meu negócio | frase | 38 | 3 | R$ 23,50 | 0 | R$ 7,83 | Search - Wings - Geral |
| wings company expansão | exata | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Franquear Negócio | Alta Intenção; SEARCH | Marca | Wings Com |
| wings company formatação | exata | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Franquear Negócio | Alta Intenção; SEARCH | Marca | Wings Com |
| wings company brasil | exata | 0 | 0 | R$ 0,00 | 0 | — | SEARCH | Franquear Negócio | Alta Intenção; SEARCH | Marca | Wings Com |
| business | exata | 0 | 0 | R$ 0,00 | 0 | — | Search leads - Wings site |
| startup | exata | 0 | 0 | R$ 0,00 | 0 | — | Search leads - Wings site |

Total das 287 palavras com dados no período: 3340 impressões, 408 cliques, R$ 2.175,62.

## Leitura

- O que mais gastou no período foi **genérico**: `[como crescer minha empresa]` (R$ 1.211, 193 cliques) e `[consultoria de franchising]` (R$ 645) — a primeira é intenção de empresário, mas não de franquear; a segunda traz também quem quer *comprar* franquia.
- As palavras de **formatação** (`formatar franquia`, `formatação de franquia`, `como transformar meu negócio em franquia`, `como estruturar uma franquia`) tiveram poucas impressões no Brasil inteiro: são de cauda longa, e é isso que sustenta a estratégia exata/frase da campanha de set/26 (13 palavras, sem ampla) — o volume real por região só o Planejador diz.
- Marca (`wings company`, `wings consultoria`, `wings franquias`) rende cliques baratos e conversão baixa: manter como grupo próprio, com lance menor.
- Antes de ampliar a lista, rodar o Planejador com Basic access; até lá, a fonte de novas palavras é o relatório de termos de pesquisa (o de 25/09 mostrou 78% do gasto de 90 dias em lixo, já negativado na campanha de set/26).
