# Modelo dimensional de vendas e marketing do Wings System

Este é o modelo de dados analíticos (data warehouse) que alimenta os painéis de mídia paga, leads, funil de vendas, governança de verba e Quiz de Franqueabilidade. Segue o método de Kimball: processo de negócio → grão → dimensões → fatos. O DDL está em `ddl.sql` (PostgreSQL 15+, schema `dw`).

## Regras do modelo

- **Nunca inventar dado.** Medida nula significa que a fonte não informou; o painel mostra "—" e o motivo. Nada de zero no lugar de nulo.
- **Sem dados pessoais.** Nome, telefone, e-mail e CPF ficam só no CRM. O DW guarda o id do contato e dados não identificáveis (UF, cidade).
- **Multi-tenant.** Toda tabela de fato tem `tenant_sk`, com isolamento por RLS (`dw.pode_ver_tenant`). A aplicação define `app.tenant_sk` por conexão; a Wings usa `app.ver_todos_tenants = on`.
- **Chave 0 = sem informação.** Cada dimensão tem a linha 0, e as chaves estrangeiras não ficam nulas. Em datas de marco, 0 quer dizer "ainda não aconteceu".
- **Histórico.** Marca, campanha e usuário usam SCD tipo 2 (`valido_de`, `valido_ate`, `atual`); o fato aponta para a versão vigente no dia do evento.
- **Taxas não ficam gravadas.** CTR, CPC e CPL são calculados nas visões, com divisão por zero virando nulo.

## Matriz de barramento

| Fato                | Data | Tenant | Marca | Canal | Campanha | Origem | Lead | Usuário | Etapa do funil | Motivo de perda | Faixa do quiz |
| ------------------- | :--: | :----: | :---: | :---: | :------: | :----: | :--: | :-----: | :------------: | :-------------: | :-----------: |
| Mídia paga diária   |  ●   |   ●    |   ●   |   ●   |    ●     |        |      |         |                |                 |               |
| Conversão de lead   |  ●   |   ●    |   ●   |   ●   |    ●     |   ●    |  ●   |         |                |                 |               |
| Negociação          |  ●   |   ●    |   ●   |   ●   |          |   ●    |  ●   |    ●    |       ●        |        ●        |               |
| Funil diário        |  ●   |   ●    |   ●   |       |          |        |      |    ●    |       ●        |                 |               |
| Aprovação de verba  |  ●   |   ●    |       |   ●   |    ●     |        |      |    ●    |                |                 |               |
| Diagnóstico do quiz |  ●   |   ●    |       |   ●   |          |   ●    |  ●   |         |                |                 |       ●       |

Câmeras (26/10/2026, migração 0098), com as dimensões próprias Unidade, Área, Dispositivo e Faixa horária:

| Fato           | Data | Faixa horária | Tenant | Unidade | Área | Dispositivo |
| -------------- | :--: | :-----------: | :----: | :-----: | :--: | :---------: |
| Fluxo por área |  ●   |       ●       |   ●    |    ●    |  ●   |      ●      |
| Alerta         |  ●   |       ●       |   ●    |    ●    |  ●   |      ●      |

## Fatos

### Mídia paga diária — `dw.fato_midia_diaria`

- **Processo:** Mídia paga
- **Tipo:** snapshot periódico
- **Grão:** Uma linha por anúncio por dia.
- **Fontes:** Meta Marketing API, Google Ads API (TikTok e LinkedIn quando ligados)
- **Responde:** Quanto investimos por campanha, marca e canal? Qual o custo por lead de cada anúncio?

| Coluna                  | Tipo          | Descrição                                                     |
| ----------------------- | ------------- | ------------------------------------------------------------- |
| `data_sk`               | integer       | dia                                                           |
| `tenant_sk`             | integer       | tenant                                                        |
| `canal_sk`              | integer       | plataforma como canal                                         |
| `campanha_sk`           | integer       | anúncio (versão vigente no dia)                               |
| `marca_sk`              | integer       | marca anunciada; 0 = institucional                            |
| `investimento`          | numeric(14,2) | valor investido no dia (aditiva); nulo = a fonte não informou |
| `impressoes`            | bigint        | impressões (aditiva)                                          |
| `cliques`               | bigint        | cliques (aditiva)                                             |
| `leads_plataforma`      | integer       | leads contados pela plataforma (aditiva)                      |
| `conversoes_plataforma` | integer       | conversões contadas pela plataforma (aditiva)                 |
| `moeda`                 | char(3)       | moeda do investimento                                         |
| `fonte`                 | text          | sistema de origem (API ou módulo do Wings System)             |
| `carregado_em`          | timestamptz   | quando a linha foi carregada                                  |

### Conversão de lead — `dw.fato_conversao`

- **Processo:** Captação de leads
- **Tipo:** transação
- **Grão:** Uma linha por conversão registrada (formulário, landing page, quiz ou WhatsApp).
- **Fontes:** RD Station Marketing, Meta Lead Ads, formulários do TikTok, site e quiz
- **Responde:** Quantos leads entraram por canal, campanha e marca? Qual origem traz mais primeiras conversões?

| Coluna               | Tipo        | Descrição                                         |
| -------------------- | ----------- | ------------------------------------------------- |
| `conversao_id`       | text        | id do evento na fonte (dimensão degenerada)       |
| `data_sk`            | integer     | dia da conversão                                  |
| `hora`               | smallint    | hora da conversão                                 |
| `tenant_sk`          | integer     | tenant                                            |
| `lead_sk`            | integer     | contato                                           |
| `marca_sk`           | integer     | marca de interesse; 0 = não informada             |
| `canal_sk`           | integer     | canal                                             |
| `campanha_sk`        | integer     | anúncio; 0 = sem anúncio                          |
| `origem_sk`          | integer     | onde converteu                                    |
| `primeira_conversao` | boolean     | primeira conversão do contato                     |
| `quantidade`         | smallint    | sempre 1, para somar contagens                    |
| `evento_em`          | timestamptz | momento exato do evento                           |
| `fonte`              | text        | sistema de origem (API ou módulo do Wings System) |
| `carregado_em`       | timestamptz | quando a linha foi carregada                      |

### Negociação — `dw.fato_negociacao`

- **Processo:** Funil de vendas
- **Tipo:** snapshot acumulado
- **Grão:** Uma linha por negociação, atualizada a cada marco do funil.
- **Fontes:** CRM do Wings System (e RD Station CRM até a migração)
- **Responde:** Quanto tempo uma negociação leva até a COF? Quantas negociações cada canal leva até o fechamento?

| Coluna                | Tipo          | Descrição                                         |
| --------------------- | ------------- | ------------------------------------------------- |
| `negociacao_id`       | text          | id da negociação (dimensão degenerada)            |
| `tenant_sk`           | integer       | tenant                                            |
| `lead_sk`             | integer       | contato                                           |
| `marca_sk`            | integer       | marca negociada                                   |
| `vendedor_sk`         | integer       | vendedor responsável (papel de dim_usuario)       |
| `canal_sk`            | integer       | canal de origem                                   |
| `origem_sk`           | integer       | origem da primeira conversão                      |
| `etapa_atual_sk`      | integer       | etapa atual                                       |
| `motivo_perda_sk`     | integer       | motivo, se perdida                                |
| `criada_sk`           | integer       | marco: criada                                     |
| `qualificada_sk`      | integer       | marco: qualificada (0 = ainda não)                |
| `reuniao_sk`          | integer       | marco: primeira reunião                           |
| `proposta_sk`         | integer       | marco: proposta enviada                           |
| `cof_enviada_sk`      | integer       | marco: Circular de Oferta de Franquia enviada     |
| `ganha_sk`            | integer       | marco: ganha                                      |
| `perdida_sk`          | integer       | marco: perdida                                    |
| `valor_estimado`      | numeric(14,2) | valor estimado; nulo = não informado              |
| `valor_fechado`       | numeric(14,2) | valor fechado, quando ganha                       |
| `dias_ate_qualificar` | integer       | dias entre criada e qualificada                   |
| `dias_ate_fechar`     | integer       | dias entre criada e ganha ou perdida              |
| `atualizado_em`       | timestamptz   | última atualização na fonte                       |
| `fonte`               | text          | sistema de origem (API ou módulo do Wings System) |
| `carregado_em`        | timestamptz   | quando a linha foi carregada                      |

### Funil diário — `dw.fato_funil_diario`

- **Processo:** Funil de vendas
- **Tipo:** snapshot periódico
- **Grão:** Uma linha por dia, marca, etapa e vendedor.
- **Fontes:** calculado a partir do CRM
- **Responde:** Como o funil evolui semana a semana? Onde as negociações ficam paradas?

| Coluna                | Tipo          | Descrição                                                   |
| --------------------- | ------------- | ----------------------------------------------------------- |
| `data_sk`             | integer       | dia da fotografia                                           |
| `tenant_sk`           | integer       | tenant                                                      |
| `marca_sk`            | integer       | marca                                                       |
| `etapa_sk`            | integer       | etapa                                                       |
| `vendedor_sk`         | integer       | vendedor                                                    |
| `negociacoes_abertas` | integer       | em aberto no fim do dia (semiaditiva: não somar entre dias) |
| `valor_em_aberto`     | numeric(14,2) | valor em aberto no fim do dia (semiaditiva)                 |
| `entradas`            | integer       | entraram na etapa no dia (aditiva)                          |
| `saidas`              | integer       | saíram da etapa no dia (aditiva)                            |
| `carregado_em`        | timestamptz   | quando a linha foi carregada                                |

### Aprovação de verba — `dw.fato_aprovacao_verba`

- **Processo:** Governança de mídia
- **Tipo:** transação
- **Grão:** Uma linha por pedido de mudança de verba feito pelo agente de tráfego.
- **Fontes:** livro-razão e gate de aprovação do Agente de Tráfego Pago
- **Responde:** Quanto tempo a Diretoria leva para aprovar? Quanto de verba foi pedido e quanto foi aprovado?

| Coluna                | Tipo          | Descrição                                         |
| --------------------- | ------------- | ------------------------------------------------- |
| `pedido_id`           | text          | id do pedido (dimensão degenerada)                |
| `data_pedido_sk`      | integer       | dia do pedido                                     |
| `data_decisao_sk`     | integer       | dia da decisão (0 = pendente)                     |
| `tenant_sk`           | integer       | tenant                                            |
| `canal_sk`            | integer       | plataforma                                        |
| `campanha_sk`         | integer       | campanha afetada                                  |
| `aprovador_sk`        | integer       | quem decidiu (papel de dim_usuario)               |
| `decisao`             | text          | resultado do pedido                               |
| `escalonado`          | boolean       | se o pedido foi escalonado                        |
| `verba_atual`         | numeric(14,2) | verba antes do pedido                             |
| `verba_proposta`      | numeric(14,2) | verba pedida pelo agente                          |
| `variacao`            | numeric(14,2) | diferença pedida                                  |
| `minutos_ate_decisao` | integer       | minutos entre pedido e decisão                    |
| `fonte`               | text          | sistema de origem (API ou módulo do Wings System) |
| `carregado_em`        | timestamptz   | quando a linha foi carregada                      |

### Diagnóstico do quiz — `dw.fato_diagnostico_quiz`

- **Processo:** Quiz de Franqueabilidade
- **Tipo:** transação
- **Grão:** Uma linha por quiz concluído.
- **Fontes:** Quiz de Franqueabilidade (site)
- **Responde:** Qual a nota média por canal? Quantos concluem o quiz e não fazem o cadastro?

| Coluna                 | Tipo        | Descrição                                         |
| ---------------------- | ----------- | ------------------------------------------------- |
| `diagnostico_id`       | text        | id do diagnóstico (dimensão degenerada)           |
| `data_sk`              | integer     | dia                                               |
| `tenant_sk`            | integer     | tenant                                            |
| `lead_sk`              | integer     | contato; 0 = anônimo até o cadastro               |
| `canal_sk`             | integer     | canal                                             |
| `origem_sk`            | integer     | origem                                            |
| `faixa_sk`             | integer     | faixa do resultado                                |
| `nota`                 | smallint    | nota final de 0 a 100 (não somar; usar média)     |
| `pontos_provado`       | smallint    | pontos na dimensão negócio provado                |
| `pontos_financeiro`    | smallint    | pontos na dimensão financeiro                     |
| `pontos_replicar`      | smallint    | pontos na dimensão capacidade de replicar         |
| `pontos_marca_mercado` | smallint    | pontos na dimensão marca e mercado                |
| `pontos_estrutura`     | smallint    | pontos na dimensão estrutura                      |
| `travas_ativas`        | smallint    | travas que limitaram a faixa                      |
| `cadastro_concluido`   | boolean     | se o lead preencheu o cadastro                    |
| `concluido_em`         | timestamptz | momento da conclusão                              |
| `fonte`                | text        | sistema de origem (API ou módulo do Wings System) |
| `carregado_em`         | timestamptz | quando a linha foi carregada                      |

### Fluxo por área — `dw.fato_fluxo_area`

- **Processo:** Câmeras: fluxo de pessoas (docs/cameras.md)
- **Tipo:** snapshot periódico
- **Grão:** Uma linha por área e dispositivo a cada 15 minutos.
- **Fontes:** lotes mandados pelo dispositivo (`POST /public/cameras/batches`), só contagens; nenhuma imagem.
- **Responde:** A que horas e em que dias entra mais gente? Quanto as salas de reunião ficam ocupadas, com quantas
  pessoas, por quanto tempo?

| Coluna                 | Tipo        | Descrição                                                                                 |
| ---------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `data_sk`              | integer     | dia (hora local)                                                                          |
| `faixa_sk`             | smallint    | faixa de 15 minutos                                                                       |
| `tenant_sk`            | integer     | tenant                                                                                    |
| `unidade_sk`           | integer     | unidade                                                                                   |
| `area_sk`              | integer     | área observada                                                                            |
| `dispositivo_sk`       | integer     | dispositivo que contou                                                                    |
| `entradas`             | integer     | pessoas que entraram na faixa (aditiva); nulo = o dispositivo não contou                  |
| `saidas`               | integer     | pessoas que saíram na faixa (aditiva); nulo = não contou                                  |
| `ocupacao_maxima`      | smallint    | maior número de pessoas ao mesmo tempo na faixa (semiaditiva: não somar; máximo ou média) |
| `permanencia_segundos` | bigint      | soma das permanências encerradas na faixa (aditiva)                                       |
| `permanencias`         | integer     | permanências encerradas na faixa (aditiva); a média sai na consulta                       |
| `inicio_em`            | timestamptz | início da faixa, instante exato                                                           |
| `fonte`                | text        | dispositivo, ou teste (dispositivo de teste: fora do painel)                              |
| `carregado_em`         | timestamptz | quando a linha foi carregada                                                              |

### Alerta — `dw.fato_alerta`

- **Processo:** Câmeras: alertas (docs/cameras.md)
- **Tipo:** transação
- **Grão:** Uma linha por alerta que o dispositivo emitiu.
- **Fontes:** lotes do dispositivo.
- **Responde:** Quantas vezes uma sala foi ocupada sem reserva, ou reservada e ficou vazia? Quantas lotações e
  permanências longas? Quando um dispositivo ficou fora do ar?

| Coluna           | Tipo        | Descrição                                                                                         |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `alerta_id`      | text        | dispositivo, início e tipo (dimensão degenerada)                                                  |
| `data_sk`        | integer     | dia do início                                                                                     |
| `faixa_sk`       | smallint    | faixa do início                                                                                   |
| `tenant_sk`      | integer     | tenant                                                                                            |
| `unidade_sk`     | integer     | unidade                                                                                           |
| `area_sk`        | integer     | área                                                                                              |
| `dispositivo_sk` | integer     | dispositivo                                                                                       |
| `tipo`           | text        | sala_ocupada_sem_reserva, sala_reservada_vazia, lotacao, permanencia_longa ou dispositivo_offline |
| `pessoas`        | smallint    | pessoas contadas no alerta, quando faz sentido                                                    |
| `iniciado_em`    | timestamptz | quando começou                                                                                    |
| `encerrado_em`   | timestamptz | quando terminou; nulo = ainda aberto quando o lote saiu                                           |
| `quantidade`     | smallint    | sempre 1, para somar contagens                                                                    |
| `fonte`          | text        | dispositivo, ou teste                                                                             |
| `carregado_em`   | timestamptz | quando a linha foi carregada                                                                      |

## Dimensões

### Data — `dw.dim_data`

Calendário, um registro por dia. data_sk no formato AAAAMMDD; 0 = sem data. Conformada (compartilhada entre fatos). Histórico: estática.

| Coluna             | Tipo     | Descrição                                           |
| ------------------ | -------- | --------------------------------------------------- |
| `data_sk`          | integer  | chave AAAAMMDD; 0 = sem data ou ainda não aconteceu |
| `data`             | date     | a data                                              |
| `dia`              | smallint | dia do mês                                          |
| `dia_semana`       | smallint | 1 = segunda … 7 = domingo (ISO)                     |
| `nome_dia`         | text     | nome do dia da semana                               |
| `semana_iso`       | smallint | semana ISO do ano                                   |
| `mes`              | smallint | mês (1–12)                                          |
| `nome_mes`         | text     | nome do mês                                         |
| `trimestre`        | smallint | trimestre (1–4)                                     |
| `ano`              | smallint | ano                                                 |
| `fim_de_semana`    | boolean  | sábado ou domingo                                   |
| `feriado_nacional` | boolean  | preenchido a partir de fonte oficial; nulo até lá   |

### Tenant — `dw.dim_tenant`

Cliente do sistema multi-tenant (a Wings ou cada franqueadora). Toda tabela de fato carrega o tenant. Conformada (compartilhada entre fatos). Histórico: tipo 1.

| Coluna      | Tipo    | Descrição                    |
| ----------- | ------- | ---------------------------- |
| `tenant_sk` | integer | chave substituta             |
| `tenant_id` | text    | id do tenant no Wings System |
| `nome`      | text    | nome do tenant               |
| `tipo`      | text    | wings ou franqueadora        |
| `ativo`     | boolean | tenant ativo                 |

### Marca — `dw.dim_marca`

Marca franqueadora trabalhada pela Wings (formatação ou expansão). Conformada (compartilhada entre fatos). Histórico: tipo 2.

| Coluna             | Tipo    | Descrição                                        |
| ------------------ | ------- | ------------------------------------------------ |
| `marca_sk`         | integer | chave substituta                                 |
| `marca_id`         | text    | id da marca no CRM                               |
| `tenant_sk`        | integer | tenant dono da marca                             |
| `nome`             | text    | nome da marca                                    |
| `segmento`         | text    | segmento de mercado                              |
| `status_comercial` | text    | situação comercial (ex.: em formatação, à venda) |
| `uf_sede`          | char(2) | UF da sede                                       |
| `cidade_sede`      | text    | cidade da sede                                   |
| `valido_de`        | date    | início da validade desta versão                  |
| `valido_ate`       | date    | fim da validade (9999-12-31 = versão atual)      |
| `atual`            | boolean | true na versão vigente                           |

### Canal — `dw.dim_canal`

Canal de aquisição: plataformas de mídia paga, orgânico, indicação, WhatsApp, direto. Conformada (compartilhada entre fatos). Histórico: tipo 1.

| Coluna         | Tipo    | Descrição                |
| -------------- | ------- | ------------------------ |
| `canal_sk`     | integer | chave substituta         |
| `canal_codigo` | text    | código estável do canal  |
| `canal_nome`   | text    | nome exibido             |
| `tipo`         | text    | pago, orgânico ou direto |

### Campanha — `dw.dim_campanha`

Hierarquia de mídia paga achatada até o anúncio: conta → campanha → conjunto → anúncio. Conformada (compartilhada entre fatos). Histórico: tipo 2.

| Coluna          | Tipo    | Descrição                                          |
| --------------- | ------- | -------------------------------------------------- |
| `campanha_sk`   | integer | chave substituta (versão do anúncio)               |
| `plataforma`    | text    | meta, google, tiktok ou linkedin                   |
| `conta_id`      | text    | conta de anúncio                                   |
| `campanha_id`   | text    | id da campanha na plataforma                       |
| `campanha_nome` | text    | nome da campanha                                   |
| `objetivo`      | text    | objetivo da campanha (ex.: leads)                  |
| `conjunto_id`   | text    | conjunto ou grupo de anúncios                      |
| `conjunto_nome` | text    | nome do conjunto                                   |
| `anuncio_id`    | text    | id do anúncio                                      |
| `anuncio_nome`  | text    | nome do anúncio                                    |
| `formato`       | text    | imagem, vídeo, carrossel ou formulário instantâneo |
| `valido_de`     | date    | início da validade desta versão                    |
| `valido_ate`    | date    | fim da validade (9999-12-31 = versão atual)        |
| `atual`         | boolean | true na versão vigente                             |

### Origem — `dw.dim_origem`

Onde o lead converteu: landing page, formulário instantâneo, site, quiz ou WhatsApp, com identificador de conversão e UTMs. Conformada (compartilhada entre fatos). Histórico: tipo 1.

| Coluna                    | Tipo    | Descrição                                                    |
| ------------------------- | ------- | ------------------------------------------------------------ |
| `origem_sk`               | integer | chave substituta                                             |
| `origem_chave`            | text    | hash dos campos que definem a origem (gerado na carga)       |
| `tipo_origem`             | text    | landing page, formulário instantâneo, site, quiz ou WhatsApp |
| `identificador_conversao` | text    | identificador de conversão do RD Station                     |
| `pagina_url`              | text    | URL da página, quando houver                                 |
| `formulario`              | text    | nome do formulário                                           |
| `utm_source`              | text    | utm_source                                                   |
| `utm_medium`              | text    | utm_medium                                                   |
| `utm_campaign`            | text    | utm_campaign                                                 |

### Lead — `dw.dim_lead`

Contato sem dados pessoais: nome, telefone, e-mail e CPF ficam só no CRM. Conformada (compartilhada entre fatos). Histórico: tipo 1.

| Coluna                | Tipo    | Descrição                 |
| --------------------- | ------- | ------------------------- |
| `lead_sk`             | integer | chave substituta          |
| `lead_id`             | text    | id do contato no CRM      |
| `tenant_sk`           | integer | tenant do contato         |
| `uf`                  | char(2) | UF informada              |
| `cidade`              | text    | cidade informada          |
| `primeiro_contato_sk` | integer | data do primeiro contato  |
| `primeiro_canal_sk`   | integer | canal do primeiro contato |

### Usuário — `dw.dim_usuario`

Usuário do sistema. Usada em vários papéis: vendedor na negociação, aprovador na verba. Conformada (compartilhada entre fatos). Histórico: tipo 2.

| Coluna       | Tipo    | Descrição                                   |
| ------------ | ------- | ------------------------------------------- |
| `usuario_sk` | integer | chave substituta                            |
| `usuario_id` | text    | id do usuário no Wings System               |
| `nome`       | text    | nome do usuário                             |
| `equipe`     | text    | equipe (ex.: Expansão, Diretoria)           |
| `papel`      | text    | nível de acesso no RBAC                     |
| `ativo`      | boolean | usuário ativo                               |
| `valido_de`  | date    | início da validade desta versão             |
| `valido_ate` | date    | fim da validade (9999-12-31 = versão atual) |
| `atual`      | boolean | true na versão vigente                      |

### Etapa do funil — `dw.dim_etapa`

Etapas dos funis do CRM, carregadas do próprio CRM, com a ordem e o tipo de cada uma. Específica de um processo. Histórico: tipo 1.

| Coluna         | Tipo     | Descrição                     |
| -------------- | -------- | ----------------------------- |
| `etapa_sk`     | integer  | chave substituta              |
| `funil`        | text     | nome do funil (ex.: Expansão) |
| `etapa_codigo` | text     | código da etapa no CRM        |
| `etapa_nome`   | text     | nome da etapa                 |
| `ordem`        | smallint | posição no funil              |
| `tipo`         | text     | aberta, ganha ou perdida      |

### Motivo de perda — `dw.dim_motivo_perda`

Motivos de perda cadastrados no CRM. Específica de um processo. Histórico: tipo 1.

| Coluna          | Tipo    | Descrição             |
| --------------- | ------- | --------------------- |
| `motivo_sk`     | integer | chave substituta      |
| `motivo_codigo` | text    | código do motivo      |
| `motivo_nome`   | text    | motivo                |
| `categoria`     | text    | agrupamento do motivo |

### Faixa do quiz — `dw.dim_faixa_quiz`

Faixas de resultado do Quiz de Franqueabilidade, carregadas da configuração do quiz. Específica de um processo. Histórico: tipo 1.

| Coluna         | Tipo     | Descrição            |
| -------------- | -------- | -------------------- |
| `faixa_sk`     | integer  | chave substituta     |
| `faixa_codigo` | text     | código da faixa      |
| `faixa_nome`   | text     | nome exibido         |
| `nota_min`     | smallint | nota mínima da faixa |
| `nota_max`     | smallint | nota máxima da faixa |
| `ordem`        | smallint | ordem de exibição    |

### Unidade — `dw.dim_unidade`

Unidade observada pelas câmeras: o escritório da Wings ou a loja de um cliente. Específica das Câmeras; tipo 1.
`marca_sk` liga a loja à rede (futuro: a franqueadora vê a rede). Colunas: `unidade_sk`, `unidade_id`, `tenant_sk`,
`marca_sk`, `nome`, `tipo` (escritorio ou loja), `cidade`, `uf`, `ativo`. RLS por tenant.

### Área — `dw.dim_area`

Área dentro de uma unidade: porta, recepção, sala de reunião, salão, caixa ou outra. Nunca uma mesa de trabalho
(decisão do Eric, 24/10/2026). Colunas: `area_sk`, `tenant_sk`, `unidade_sk`, `area_codigo` (único na unidade), `nome`,
`tipo`, `capacidade` (lugares, quando informado), `ativo`. RLS por tenant.

### Dispositivo — `dw.dim_dispositivo`

Câmera que conta sozinha, ou caixa de análise (computador local) que lê as câmeras e manda os lotes. O token fica em
`public.camera_devices`, só como SHA-256. Colunas: `dispositivo_sk`, `dispositivo_id`, `tenant_sk`, `unidade_sk`,
`area_sk`, `nome`, `tipo` (camera ou caixa), `fabricante`, `modelo`, `teste` (dispositivo de teste: lotes fora do
painel), `ativo` (false depois de revogado), `instalado_em`. RLS por tenant.

### Faixa horária — `dw.dim_faixa_horaria`

As 96 faixas de 15 minutos do dia (hora local): `faixa_sk` 1 = 00:00–00:15 … 96 = 23:45–24:00; 0 = sem informação.
Colunas: `inicio`, `fim`, `hora`, `minuto`, `periodo` (madrugada, manhã, tarde, noite). `dw.faixa_sk(instante)` dá a
faixa de um instante na hora de São Paulo; `dw.data_sk(instante)` a chave AAAAMMDD (criada aqui com OR REPLACE, porque a
migração 0097 da Produtividade cria a mesma).

## Visões para os painéis

- `dw.vw_midia_mensal`: investimento, impressões, cliques, leads, CTR, CPC e CPL por mês, canal, campanha e marca, com a contagem de dias em que a fonte não informou o investimento.
- `dw.vw_funil_marcos`: negociações criadas, qualificadas, com reunião, proposta, COF enviada, ganhas e perdidas por mês de criação, marca e canal, e a média de dias até ganhar.

## Carga

1. Dimensões antes dos fatos, sempre pela chave natural (`*_id`, `*_codigo`).
2. Mídia paga: reprocessar os últimos 7 dias a cada carga, porque as plataformas ajustam números retroativamente.
3. Negociações: atualizar a linha a cada mudança de etapa (snapshot acumulado); o funil diário é calculado no fim do dia.
4. Cada linha registra `fonte` e `carregado_em`.

5. Câmeras (26/10/2026): não há ETL. O dispositivo escreve direto nos fatos pela API (`apps/api/src/modules/cameras`),
   idempotente pela chave dispositivo + intervalo (`on conflict do update`); o cadastro do Admin Master escreve as
   dimensões. Um dispositivo de teste grava `fonte = teste`, e o painel ignora essas linhas.

## Validação

- Contagem de conversões do mês bate com o RD Station e com os formulários de origem.
- Investimento do mês por conta bate com o painel de cada plataforma (mesma conciliação do agente de tráfego).
- Nenhuma medida preenchida com zero quando a fonte não informou.
- Câmeras (`cameras.test.ts`): o painel reproduz os totais de um lote gravado (entradas por hora e por dia, picos,
  ocupação da sala, alertas); o lote de um dispositivo de teste não muda nenhum número.
