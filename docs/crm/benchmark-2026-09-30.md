# CRM Vendas — benchmark e ordem das fases (30/09/2026)

Decisão do Eric: o CRM Vendas terá estrutura completa de CRM e será melhor
que HubSpot Sales Hub, RD Station CRM e Syonet **para o uso da Wings**
(franqueadora que vende Formatação e faz Expansão de marcas-cliente). Este
documento complementa a [especificação](fase1-especificacao.md) e o
[complemento da Fase 1](fase1-complemento-funil.md). **Só plano**: nada foi
construído.

Método: sites oficiais e centrais de ajuda de cada produto, lidos em 30/09/2026
(HubSpot: knowledge.hubspot.com e página de preços; RD: ajuda.rdstation.com,
developers.rdstation.com e página de planos; Syonet: syonet.com, materiais e
blog oficiais, lojas de app e portal LGPD — a Syonet **não tem central de ajuda
pública**, então suas linhas valem como material de marketing). O que não foi
encontrado em fonte oficial está como "—". "Wings (hoje)" é o que está no
develop; "Wings (plano)" é o que este documento propõe; "Fase" aponta para a
tabela da seção 3.

## 1. Matriz

Legenda: **S** tem; **P** parcial (existe com limite, add-on ou noutro produto
da mesma casa); **N** não; **—** não achado em fonte oficial. Fontes na seção 4,
por número.

| # | Funcionalidade | HubSpot Sales Hub | RD Station CRM | Syonet | Wings (hoje) | Wings (plano) | Fase | Fontes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Contatos, empresas, negócios | S — objetos associados, objetos personalizados só Enterprise | S — Empresa → Negociações, contato de uma empresa, ilimitados em todos os planos | P — clientes/não clientes/leads e "ficha de negociação" por montadora; sem entidade empresa documentada | P — `leads` (a chegada), `clients` (marcas), espelho `rd_crm_deals` sem dado pessoal; sem negociação própria | S — `crm_contacts`, `crm_companies`, `crm_deals` com `client_id` (marca) e `lead_id` (spec §1) | 4 | H1, R1, S1 |
| 2 | Múltiplos funis e etapas | S — Starter 15 funis, Pro 100, Ent 350; etapas com probabilidade | S — Free 1 funil fixo; Basic+ ilimitados, até 12 etapas, paralelos/sequenciais, Playbook por etapa | P — "funil inteligente", kanban no app; etapas configuráveis não documentadas | N — `leads.status` só `new`; funis do RD só lidos no espelho | S — funis por linha de produto **e por marca** (Formatação; Expansão/Casal; Expansão/Açaí…), etapa com SLA e `is_first_contact` (spec §1.1); Fase 1 já mostra funil e etapa lidos do RD | 1 (leitura), 4 | H2, R2, S2 |
| 3 | Motivos de perda | S — propriedade padrão editável + relatório | S — obrigatório ao perder; Free 50, Basic+ ilimitados; por funil no Pro | — | P — só o motivo lido do RD (espelho) | S — lista com `requires_note`, de-para dos 18 do RD (spec §4.3) | 4 | H3, R3 |
| 4 | Distribuição automática (rodízio/regras) e dono | S — ação de workflow "rotate": round robin, balanceado, aleatório; só Pro/Ent | P — sem rodízio nativo no CRM: vem do fluxo do RD Marketing ou de automação "mudar responsável"; Roleta é do Marketing Pro | S — "Central de Leads": distribuição programável, lead volta à fila se o vendedor não interage em 5 min | N — `owner_employee_id` existe e nunca é preenchido; dono definido no RD pelo `expansion-intake` | S — rodízio por funil com peso, sob lock, 1º contato em N min ou volta à fila (spec §4.1, §4.4); Fase 1: dono fixo por funil (Fernando) | 1 (fixo), 4 | H4, R4, S4 |
| 5 | Tarefas, agenda, lembretes, SLA | P — tarefas e lembretes em todos; reuniões; **SLA só de tickets** (Service Hub Pro) | P — tarefas ligadas ao negócio, tipos fixos, lembrete diário por e-mail; **sem SLA**: "gatilhos" de alerta e métrica "tempo de 1º contato" (Pro) | P — agenda de visitas, lembretes no app; SLA só o de 5 min do lead | N — tarefa "Fazer primeiro contato" é criada no RD; `unanswered_since` na fase 0 do WhatsApp | S — `crm_tasks`, tarefas do dia, **SLA de primeiro contato e por etapa** com alerta e escalada (spec §1.6, §4.4), agenda do vendedor | 4 (tarefas/SLA), 9 (agenda externa) | H5, R5, S5 |
| 6 | Cadências de follow-up | S — Sequences: e-mails + tarefas, até 90 dias úteis, sai ao responder; Pro/Ent | P — sem objeto cadência; automações "negócio parado N dias → e-mail/tarefa" (Pro modelos, Advanced personalizadas) | S — fluxos pré-programados de resgate e acompanhamento (e-mail, SMS, WhatsApp) | N | S — cadência por funil e etapa, passos WhatsApp/e-mail/tarefa, **executada pela Sofia com aprovação por card** (nunca envio automático sem regra aprovada), sai ao responder | 3 (Sofia), 8 (editor) | H6, R6, S6 |
| 7 | Histórico / linha do tempo | S — aba Activities com tudo, filtros | S — histórico **imutável** por negócio; a API expõe `deal_stage_histories` (etapa, início, fim) | S — "linha do tempo com todas as interações" | P — `lead_events` e `audit_log` por id (sem dado pessoal); mensagens na fase 0 | S — `crm_stage_history` append-only (etapa, status, dono) + eventos + mensagens + tarefas na mesma linha do tempo (spec §1.3) | 1 (leads), 4 | H7, R7, R21, S7 |
| 8 | WhatsApp, e-mail e telefonia no card | P — e-mail e ligação no card (minutos por plano); **WhatsApp só com Marketing/Service Hub Pro**, 1.000 templates/mês | S — WhatsApp = extensão do Chrome sobre WhatsApp Web; API só via RD Conversas; e-mail 1:1 no card; webphone R$ 94/usuário | S — WhatsApp oficial homologado, 1 número por loja; telefonia com 10 centrais; e-mail só campanha | P — fase 0 guarda toda mensagem do número da Wings (não mesclada); e-mail só transacional; sem telefonia | S — **caixa de entrada nativa** pela API oficial (WhatsApp Business Platform / Cloud API, decisão de 30/09), responder, assumir, mídia, no card do lead/negócio; e-mail 1:1 pelo SMTP da Wings; telefonia via link `tel:`/WhatsApp voice (integração de central fica fora) | 1 (trilho), 2 (inbox), 8 (e-mail) | H8, R8, S8 |
| 9 | Propostas e produtos | S — catálogo com preço em faixas, cotações com assinatura e pagamento (assento Revenue Hub) | S — catálogo, proposta por modelo com variáveis, link/PDF, eventos de leitura/aceite; Basic+ | P — ficha por montadora, catálogo de peças; sem gerador de proposta | N — `client_contracts`/`client_franchise_plans` são contrato do cliente, não proposta | S — `crm_products` (Exclusive, Pocket, módulos, franquia), proposta em PDF pelo Drive com variáveis, aceite por link assinado, eventos no histórico (spec §1.3) | 7 | H9, R9, S9 |
| 10 | Metas e comissões | P — metas por usuário/equipe/funil; **comissão não é nativa** (apps do marketplace) | P — metas com projeção no ritmo atual; comissão: não achado | P — metas e ranking só no módulo de peças; comissão não achada | N | S — metas por vendedor/funil/mês e **regra de comissão por produto e etapa**, apurada e exportável, nunca calculada sem regra cadastrada | 7 | H10, R10, S10 |
| 11 | Previsão de vendas (forecast) | S — por etapa ou categoria, submissão manual, IA; Pro/Ent | P — só "valor previsto" por etapa e projeção da meta | — | N | S — forecast por etapa com probabilidade **medida** no histórico real da Wings (não chute), por funil e marca; "—" enquanto não houver 90 dias de histórico | 7 | H11, R11 |
| 12 | Relatórios e dashboards | S — construtor personalizado (Pro/Ent), painéis em todos | S — 15 relatórios prontos; personalizados só no Advanced | S — módulo de KPI por grupo/loja, dashboard de ROI/CPL | P — Cockpit de marketing (CPL, CAC, leads das campanhas); nada de vendas | S — painel do gestor (spec §2), taxa por etapa por campanha e por marca, tempo por etapa, CPL/CAC real | 4 (básico), 6 (ads) | H12, R12, S12 |
| 13 | Automações (gatilho → ação) | S — workflows: Starter 50 limitados, Pro 300, Ent 1.000 | S — Pro só modelos (50), Advanced personalizadas (100); Free/Basic nenhuma | P — fluxos pré-prontos; sem editor genérico documentado | P — jobs fixos (entrada de leads, ingestão, alertas de anúncios); sem editor | S — editor gatilho → ação (negócio criado/movido/parado, campo mudou → tarefa, mover, perder, cadência, WhatsApp via Sofia), sempre com registro e limite de disparo; **nunca em anúncio/verba** | 8 | H13, R13, S13 |
| 14 | Lead scoring | S — engajamento + fit; preditivo no Enterprise | P — 1 a 5 estrelas manual ou por questionário; scoring de verdade é do RD Marketing | S — leadscore por pontos de interação | S — `franchiseeScoreOf` 0–100 explicável (capital, gestão, área) + pesquisa pública com ledger; nunca rodou no staging | S — nota **por marca** (área de expansão, ticket, perfil do franqueado da marca) e reavaliada pela Sofia com o que o lead responde; classe A/B/C/Inconclusivo com pesos 35/25/25/15 (sugestão Manus, §3.1) | 1 (ligar), 3 (Sofia), 4 (classes) | H14, R14, S14 |
| 15 | Importação / deduplicação | S — dedupe por e-mail/domínio na importação; gestor de duplicados Pro/Ent | P — importação por planilha com "verificar duplicidades"; campos únicos; **sem mesclar registros** | P — importação só no Mailtop | P — `upsertLead` (id de origem → telefone → e-mail); sem importação por planilha | S — importador do RD com dedupe conservadora e fila de "possíveis duplicados" (spec §3.2); planilha depois | 1 (RD → Funil), 5 (completa), 8 (planilha) | H15, R15, S15 |
| 16 | Campos personalizados | S — tipos, validação, sensíveis no Enterprise | S — texto/data/escolha; obrigatório por etapa no Pro | — | N | S — `crm_custom_fields` por objeto e funil, obrigatório por etapa, os 17 de investimento do RD unificados (spec §1.5, §3.4) | 4 | H16, R16 |
| 17 | Permissões por equipe | S — equipes Pro, hierárquicas e por campo só Enterprise | S — Restrita/Equipe/Geral por objeto; perfis personalizados Pro 1, Advanced 10 | P — "só quem tem permissão", visões por cargo; matriz não documentada | S — RBAC central com escopo own/setor/tudo, regra de negação (Diretoria × TI), auditoria | S — `crm.*` com escopo na consulta, `crm.reassign` para gestor de setor, `crm.sensitive` auditado (spec §1.8) | 4 | H17, R17, S17 |
| 18 | App celular | S — iOS/Android completo, sem offline | S — app gratuito: negócios, tarefas, relatórios; sem ligações/e-mail | S — app com kanban, agenda, notificações; offline descontinuado em 2025 | N — web; sem PWA nem push | P — **PWA instalável com push** (nova mensagem, SLA estourando, tarefa do dia); app nativo fora do plano | 9 | H18, R18, S18 |
| 19 | Integrações: Meta/Google Ads com conversão offline, RD Marketing, agenda | P — lead ads em todos; **CAPI/Google Enhanced só com Marketing Hub**; agenda Google/Outlook nativa; RD Marketing: não achado | P — RD Marketing nativo; Meta Lead Ads via Pluga; CAPI e públicos são do RD Marketing; Google offline só app de terceiro; Google Agenda beta, só ida | P — Meta Ads e Google como serviço gerido; portais e montadoras; sem Google/Outlook | P — lê e escreve campanhas Meta/Google (nascem pausadas), RD Marketing (conversões, entrada), RD CRM (espelho, cria negócio), Z-API; **sem CAPI/offline, sem agenda** | S — Meta CAPI e Google conversões offline com **reunião realizada e venda** (evento, `event_id`, janela), CPL/CAC real por campanha no Cockpit; Google Agenda de ida e volta para reuniões | 1 (fontes), 6 (ads), 9 (agenda) | H19, R19, S19 |
| 20 | Auditoria e LGPD | S — audit log (mudanças de CRM só Enterprise); consentimento em formulários, exclusão GDPR, tipos de assinatura (Marketing Starter+) | P — histórico imutável por negócio; base legal por contato e canal; lixeira com aprovação; sem log de conta; opt-out é do Marketing | S — log de quem/quando; **Portal do Titular** (consentimentos, correção, portabilidade, anonimização/exclusão) | P — `audit_log` append-only, CPF cifrado com revelação auditada, base legal por lead; sem opt-out nem exclusão | S — opt-out por "PARAR" no WhatsApp e link no e-mail, pedido de exclusão/anonimização com fluxo e prazo, revelação de dado pessoal auditada, exportação auditada; Jurídico define bases | 2 (PARAR), 10 | H20, R20, S20 |
| 21 | Preço (referência) | Free 2 usuários; Starter US$ 20/assento/mês; Pro US$ 100 + US$ 1.500 de onboarding; Ent US$ 150 + US$ 3.500 | Free 4 usuários; Basic R$ 73; Pro R$ 131 (mín. 4); Advanced sob consulta; webphone R$ 94 | sob consulta; só automotivo | custo de desenvolvimento e servidor | idem | — | H21, R22, S21 |

O que o benchmark muda no que já estava escrito: a especificação (§0, §3.7)
diz que "o RD não tem histórico de etapas". **Tem**: a central de ajuda diz que
o histórico da negociação é imutável e registra funil e etapa com usuário, data
e hora, e a API `GET /deals/{id}` devolve `deal_stage_histories` com início e
fim por etapa (R21). Consequências: a importação completa (Fase 5) traz o
histórico real, não uma linha `import`; e o "tempo até o primeiro contato" da
Expansão, que ficou "—" no diagnóstico de 30/09, pode ser medido já na Fase 1
lendo esse campo (uma chamada por negócio, ~400).

## 2. Onde a Wings será melhor (para o uso da Wings)

1. **WhatsApp nativo + Sofia qualificando por marca.** Nos três concorrentes o
   WhatsApp é add-on (HubSpot: outro Hub; RD: extensão do Chrome ou RD Conversas
   à parte; Syonet: 1 número por loja) e nenhum tem um SDR que leia a conversa e
   proponha o próximo passo. Na Wings a conversa já nasce ligada ao lead e à
   marca (fase 0), a Sofia resume, pontua e sugere — e **só envia com aprovação
   por card** (regra da casa: lê e propõe). SLA de primeiro contato real, que
   HubSpot só tem em tickets e RD não tem.
2. **Modelo de franquias.** Marca é cliente (`client_id`), funis de Formatação e
   de Expansão por marca, perfil do candidato a franqueado (capital, gestão,
   cidade na área de expansão da marca), regras de origem por LP/formulário/
   número por marca. Nenhum dos três modela "vendo para a marca X em nome dela";
   a Syonet é o mais perto (grupo → concessionária), mas fechada em automotivo.
3. **Ciclo fechado com anúncios.** O sistema já lê e escreve as campanhas; a
   Fase 6 devolve **reunião realizada** e **venda** para a Meta (CAPI) e para o
   Google (conversões offline), com `event_id` para deduplicar com o pixel, e
   mostra CPL/CAC por campanha com o que chegou ao CRM ("a Meta diz × chegou").
   HubSpot só faz isso com Marketing Hub e por estágio de ciclo de vida; RD, por
   app de terceiro; Syonet, não documenta.
4. **"Nunca inventar dados".** Todo número tem fonte e janela; sem dado, "—" e
   o motivo (padrão já usado no bloco 11 da Meta e no diagnóstico). Forecast só
   com probabilidade medida; comissão só com regra cadastrada; conversão por
   etapa só a partir do histórico real.
5. **Auditoria e LGPD de ponta a ponta**, que hoje só a Syonet leva a sério
   (Portal do Titular): revelação de dado pessoal auditada, opt-out no canal
   em que a pessoa está, exclusão com fluxo.

## 3. Ordem das fases (por impacto para a Wings)

Fases 1 a 3 continuam as combinadas. Dias = desenvolvimento com testes, sem
revisão nem espera de decisão. As estimativas das fases 4 a 10 são de plano,
a refinar quando cada uma for aberta.

| Fase | Conteúdo | Dias | Depende de |
| --- | --- | ---: | --- |
| 1 | **Funil ligado às fontes + Expansão**: RD webhook, site do Calçadão, links de WhatsApp por marca (sem Z-API), Meta Lead Ads (webhook + leitura), RD CRM → Funil com marca, etapa e **tempo até 1º contato** (`deal_stage_histories`), tela do Funil ([complemento](fase1-complemento-funil.md)) | 14,5 | Eric: RD webhook, segredos, marcas como clientes, app da Meta |
| 2 | **Inbox WhatsApp pela API oficial** (WhatsApp Business Platform / Cloud API; **não Z-API**, decisão de 30/09): webhook `messages`/`statuses` assinado (`X-Hub-Signature-256`) com verify token; tela, enviar, assumir/reatribuir, "Conversar no WhatsApp" no card, conversa sem código vira lead, mídia baixada pelo id e servida por link assinado; **janela de 24 h**: resposta livre só dentro dela, fora dela só modelo aprovado pela Meta (cobrado por mensagem, tabela da Meta conferida no dia); opt-out "PARAR"; aproveita o modelo da fase 0 (`wa_conversations`/`wa_messages`, ligação pelo telefone) com o adaptador reescrito | 10 | Eric: número na WABA do Business Manager, token de usuário do sistema com `whatsapp_business_messaging`/`whatsapp_business_management`, webhook no app, modelos de mensagem aprovados; decidir se o número segue no app WhatsApp Business (coexistência, conferir disponibilidade) |
| 3 | **Sofia (SDR IA)**: qualificação por marca a partir da conversa e da pesquisa, resumo, SLA com alerta, card de follow-up com aprovação, passagem de bastão = troca de dono; `run_at` nos jobs | 10 | fase 2; teto de custo de modelo por dia |
| 4 | **CRM base**: `crm_*` (contatos, empresas, negócios, etapas, motivos, campos, tarefas), `moveDeal` + histórico append-only, kanban e detalhe, tarefas do dia, rodízio, SLA por etapa, triagem de parados, permissões `crm.*`, relatórios básicos (spec §1, §2, §4). **Sugestão Manus (§3.1):** campos de empresa para franquia, lead scoring A/B/C/Inconclusivo, regra "nenhum lead sem responsável, etapa e próxima atividade", tela de trabalho do vendedor, briefing por IA (fato/hipótese/confirmar), perfis de acesso | 15 + 9 | decisões §8 da spec (rodízio, motivos, SLA); critérios do scoring |
| 5 | **Importação completa do RD e virada**: usuários, funis, 5.577 contatos com dedupe, 5.903 negócios **com histórico real de etapas**, tarefas e anotações, validação de contagens, convivência e critério de desligar o RD CRM (spec §3, §5.2) | 8 | fase 4; Jurídico (base legal dos 4.093 sem base) |
| 6 | **Ciclo fechado com anúncios**: Meta CAPI e Google conversões offline para reunião realizada e venda (`event_id`, janela, consentimento), CPL/CAC real por campanha e marca no Cockpit, taxa por etapa por campanha; o agente lê, não envia; primeira metade do relatório **investimento → lead → qualificado → reunião** (sugestão Manus) | 6 | fase 4; Jurídico (envio de hash de dado pessoal às plataformas) |
| 7 | **Propostas, produtos, metas, comissões, forecast**: catálogo, proposta em PDF com aceite por link, metas por vendedor/funil, regra de comissão apurável, forecast por probabilidade medida; relatório completo **investimento → lead → qualificado → reunião → proposta → contrato → receita** por campanha, marca e vendedor (sugestão Manus) | 8 + 2 | fase 5 (90 dias de histórico para o forecast) |
| 8 | **Automações e cadências**: editor gatilho → ação, cadências por funil/etapa executadas pela Sofia, e-mail 1:1 no card, importação por planilha, campos personalizados na tela de configuração | 10 | fases 3 e 4 |
| 9 | **Celular e agenda**: PWA instalável com push (mensagem, SLA, tarefa), Google Agenda ida e volta para reuniões, `tel:` no card | 8 | fase 2 (push já previsto na fase 3 do WhatsApp) |
| 10 | **LGPD completo e auditoria de leitura**: pedido de exclusão/anonimização com prazo, exportação auditada, log de visualização de dado pessoal, política de retenção | 5 | Jurídico |
| 11 | **Pós-venda da Formatação** (sugestão Manus): tickets por cliente formatado, SLA de resposta e resolução, NPS por marco do projeto, ligado ao cadastro de clientes e aos projetos (Gestão → Projetos) | 8 | fase 4; Diretoria define marcos e SLA |
| | **Total após a Fase 1** | **99** | |

Estimativas das fases 4, 7 e 11 atualizadas em 30/09 com a sugestão Manus
(+9, +2 e 8 dias); Fase 2 de 8 para 10 dias pela API oficial (modelos de
mensagem, janela de 24 h, adaptador novo).

### 3.1 Sugestão Manus (acrescentada em 30/09, decisão do Eric)

Entra da Fase 4 em diante. Onde o pedido não trouxe o detalhe, o item diz o que
falta e ninguém o inventa.

| Item | O que é | Fase | Dias | Falta definir |
| --- | --- | --- | ---: | --- |
| Campos de empresa para franquia | em `crm_companies`: CNPJ (validador do cadastro de clientes), segmento, número de unidades, faixa de faturamento, franqueabilidade, fit Wings, **fonte e data de cada dado** (quem disse, de onde veio, quando) | 4 | 1 | as faixas de faturamento e a escala de franqueabilidade e de fit |
| Lead scoring 35/25/25/15 → A/B/C/Inconclusivo | nota de 0 a 100 com quatro critérios de pesos 35, 25, 25 e 15; classe A, B ou C pelos cortes; **Inconclusivo** quando faltar dado para decidir, em vez de nota inventada; cada critério mostra o dado e a fonte | 4 | 2 | os quatro critérios e os cortes de A/B/C (a sugestão trouxe os pesos; o texto completo não está no repositório) |
| "Nenhum lead sem responsável, etapa e próxima atividade" | validação no servidor em `moveDeal` e na criação: negócio aberto sem dono, etapa ou tarefa futura não é salvo; os que já estão assim entram numa fila de correção no painel do gestor | 4 | 1 | — |
| Tela de trabalho do vendedor | a abertura do vendedor (amplia "Tarefas do dia", spec §2.4): próximas atividades, primeiro contato com cronômetro, negócios sem próxima atividade, conversas sem resposta, classe do lead | 4 | 2 | — |
| Briefing por IA | no detalhe do negócio, antes da reunião: três blocos separados — **fato** (com fonte e data), **hipótese** (marcada como tal) e **a confirmar** (perguntas para o vendedor fazer); lê e propõe, nunca escreve no negócio; teto de custo de modelo por dia | 4 | 2 | teto de custo |
| Perfis de acesso | perfis prontos sobre as chaves `crm.*`: vendedor, SDR, gestor comercial, Diretoria, pós-venda, marketing (só números agregados, sem dado pessoal); escopo sempre na consulta | 4 | 1 | quem fica em cada perfil |
| Relatório investimento → receita | investimento → lead → qualificado → reunião → proposta → contrato → receita, por campanha, marca e vendedor, com a fonte e a janela de cada número e "—" quando não houver dado | 6 (até reunião), 7 (completo) | 2 | o que conta como "qualificado" (classe A/B?) e como "receita" (contrato assinado ou pagamento) |
| Pós-venda da Formatação | tickets, SLA e NPS (Fase 11) | 11 | 8 | marcos do projeto em que o NPS é pedido; SLA por tipo de ticket |

### 3.2 Fase 2 — número oficial do WhatsApp (decisão pendente, registrada em 30/09)

Não muda a Fase 1. Número oficial da Wings Company para a API oficial:
**+55 21 99947-0288**, hoje no app WhatsApp Business.

| Opção | Como fica | Prós | Contras |
| --- | --- | --- | --- |
| **A (recomendada)** — Cloud API direto com a Meta | o número migra do app para a API **só quando a inbox do CRM estiver pronta e testada** (testes com um número de teste da Meta até lá) | sem intermediário nem mensalidade de parceiro; tokens e webhook só no nosso servidor | depois da migração **o app WhatsApp Business deixa de funcionar nesse número**; o histórico do app não passa para a API |
| B — parceiro oficial (BSP) com coexistência | o mesmo número no app **e** na API ao mesmo tempo | o time continua no celular durante a transição | custo e dependência do parceiro; tokens e mensagens passam por terceiro (revisão LGPD e de contrato); limites da coexistência a conferir na documentação da Meta no dia |

**Decisão pendente do Eric:** A ou B, e a data de virada.

Checklist de migração (opção A):

1. **Antes:** inbox do CRM pronta e testada ponta a ponta com número de teste (receber, responder na janela de 24 h, modelo aprovado fora dela, mídia, opt-out "PARAR").
2. **Backup/exportação:** exportar as conversas do app (no celular, cada conversa → Mais → Exportar conversa, com mídia) e fazer o backup do app; guardar os arquivos numa pasta restrita do Drive (dado pessoal: acesso só Comercial/Diretoria, sem cópia em e-mail).
3. **Modelos de mensagem** aprovados pela Meta antes da virada (retomar conversa fora da janela, aviso de novo canal).
4. **Data de virada** marcada fora de campanha em pico; conferir que nenhum anúncio "clique para WhatsApp" dependa do app naquele dia.
5. **Aviso ao time** (quem atende pelo celular): data, a partir de quando responder só pelo CRM, onde está o histórico exportado.
6. **Virada:** registrar o número na WABA da Wings (verificação por SMS/ligação), apontar o webhook, conferir a primeira mensagem recebida e enviada.
7. **Depois:** acompanhar por 1 semana as mensagens sem resposta; plano de volta = só com a opção B (número de volta ao app perde a API).

O que acontece com o histórico: na opção A, as conversas antigas **ficam só na exportação/backup** (não entram na API nem no CRM automaticamente); o CRM começa a partir da virada, e cada lead existente é ligado pelo telefone quando voltar a falar. Importar a exportação para a linha do tempo do lead é possível depois, como tarefa própria (arquivo de texto, dado pessoal, só com decisão do Jurídico). Na opção B, a coexistência pode trazer parte do histórico recente para a API — alcance e prazo a conferir na documentação da Meta no dia da decisão.

### 3.3 Fase 2 — app da Meta e variáveis (registrado em 30/09)

O Eric criou o app da Meta **"Wings CRM Vendas"** (portfólio BM "Wings Company
01", empresa já verificada), caso de uso WhatsApp. É um app **separado** do
"Wings Traffic Agent" (anúncios): a assinatura do webhook do WhatsApp é
conferida com o segredo deste app, não com `META_APP_SECRET`.

IDs (não são segredo):

| O quê | Valor |
| --- | --- |
| App ID | `1579023596665415` |
| WABA de **teste** | `2116475762622670` |
| Phone Number ID de **teste** | `1253469287856067` (número de teste +1 555 669 6643) |

Variáveis no Coolify (`wings-api-staging`), só pelos nomes:

| Variável | Quem grava | Nota |
| --- | --- | --- |
| `WHATSAPP_APP_ID` | Opus/Sonnet (não é segredo) | `1579023596665415` |
| `WHATSAPP_WABA_ID` | Opus/Sonnet (não é segredo) | WABA de teste até a virada do número (§3.2) |
| `WHATSAPP_PHONE_NUMBER_ID` | Opus/Sonnet (não é segredo) | número de teste até a virada |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | gerado no servidor na Fase 2 (`openssl rand`), gravado com `wings-env set`, nunca impresso | o mesmo valor vai no campo "Verify token" do webhook no painel do app |
| `WHATSAPP_APP_SECRET` | **Eric, direto no Coolify** | nunca impresso, nunca em log, nunca em resposta |
| `WHATSAPP_ACCESS_TOKEN` | **Eric, direto no Coolify** | token permanente de usuário do sistema; nunca impresso, nunca ao navegador nem a modelo |

**Atualização 30/09 (noite):** `WHATSAPP_APP_SECRET` e `WHATSAPP_ACCESS_TOKEN`
já estão no `wings-api-staging` (gravados pelo Eric; build time desligado;
entram no próximo deploy). O token é **permanente**, do usuário do sistema
"wings-crm" (id `61594642964237`), com acesso total ao app "Wings CRM Vendas" e
à Test WhatsApp Business Account, permissões `whatsapp_business_management` e
`whatsapp_business_messaging`. Os três ids não secretos (`WHATSAPP_APP_ID`,
`WHATSAPP_WABA_ID`, `WHATSAPP_PHONE_NUMBER_ID`) o Opus grava com `wings-env
set api-staging` no início da Fase 2, junto com o código que os lê (o Eric não
precisa pôr); `WHATSAPP_WEBHOOK_VERIFY_TOKEN` quando o webhook for configurado.

**A investigar no início da Fase 2 (só leitura):** o portfólio tem mais **duas
contas WhatsApp Business chamadas "Wings Company"**, criadas antes. Conferir se
alguma já tem o +55 21 99947-0288: `GET /{waba_id}/phone_numbers` de cada uma
(campos `display_phone_number`, `verified_name`, `status`,
`platform_type`/`code_verification_status`). O token do "wings-crm" só vê o app
e a WABA de teste; para ler as outras duas, o Eric dá ao usuário do sistema
acesso de leitura a elas no Business Manager (ou lê na tela: Configurações do
negócio → Contas do WhatsApp → cada conta → Números de telefone). O que muda:

- número **em nenhuma**: migração como no §3.2, na WABA de produção que for escolhida;
- número numa delas **só cadastrado, sem API ativa**: usar essa WABA (evita
  registrar o número duas vezes) ou removê-lo dela antes de migrar;
- número numa delas **já na Cloud API/On-Premises** (com outro app ou
  parceiro): o app WhatsApp Business já não estaria nele; descobrir quem opera,
  e a migração vira troca de app/WABA (migração entre WABAs da Meta), não
  saída do app;
- as WABAs vazias e sem uso: arquivar depois da virada, para não confundir.

**Avisos internos que ainda usam o Z-API (registrado em 30/09):** o Wings
System manda por Z-API (`apps/api/src/lib/zapi.ts`) os pedidos de aprovação de
anúncios, os alertas críticos e o notifier do roadmap, com `ZAPI_INSTANCE_ID`,
`ZAPI_INSTANCE_TOKEN` e `ZAPI_CLIENT_TOKEN` no staging e na produção. Na Fase 2:
migrar esses avisos para a Cloud API com **modelo de utilidade aprovado** pela
Meta (fora da janela de 24 h só modelo), testar a entrega de cada tipo de aviso
(aprovação, alerta crítico, roadmap) e **só então** avisar o Eric de que pode
cancelar o Z-API e remover as 3 variáveis. Até lá o Z-API continua.

Nada disso é usado na Fase 1 e nenhum deploy é feito só por causa dele. Na
virada para o número oficial (+55 21 99947-0288), `WHATSAPP_WABA_ID` e
`WHATSAPP_PHONE_NUMBER_ID` trocam para os de produção.

Fora do plano (decisão explícita): app nativo iOS/Android, telefonia com
central (PABX), substituir o RD Marketing (LPs, e-mail em massa), objetos
personalizados genéricos, marketplace de integrações.

## 4. Fontes

HubSpot (knowledge.hubspot.com salvo indicação):
H1 records/associate-records · H2 object-settings/set-up-and-customize-pipelines · H3 properties/hubspots-default-deal-properties · H4 workflows/assign-and-rotate-record-owners-using-workflows; crm-setup/how-to-set-an-owner · H5 tasks/create-tasks; meetings-tool/create-a-team-meetings-link; help-desk/set-sla-goals-in-help-desk · H6 sequences/create-and-edit-sequences · H7 records/work-with-records · H8 connected-email/connect-your-inbox-to-hubspot; calling/make-calls-in-the-hubspot-browser; inbox/connect-whatsapp-to-the-conversations-inbox · H9 quotes/create-and-send-quotes; products/create-and-manage-products · H10 reports/create-sales-goals; hubspot.com/glossary/sales-commission · H11 forecast/use-the-forecast-tool · H12 reports/create-reports-with-the-custom-report-builder; dashboards/customize-your-dashboards · H13 workflows/create-workflows; hubspot.com/pricing/sales · H14 scoring/understand-the-lead-scoring-tool · H15 records/deduplication-of-records; records/manage-duplicate-records · H16 properties/create-and-edit-properties · H17 user-management/create-and-manage-teams; properties/restrict-view-edit-access-for-properties · H18 hubspot.com/products/mobile; records/work-with-records-in-the-hubspot-mobile-app · H19 ads/sync-leads-from-your-facebook-page-or-linkedin-ads-account-to-hubspot; ads/create-and-sync-ad-conversion-events-with-your-meta-ads-accounts-using-metas-conversion-api; ads/create-and-sync-ad-conversion-events-with-your-google-ads-account; integrations/use-hubspots-integration-with-google-calendar-or-outlook-calendar · H20 account-management/view-and-export-account-activity-history; privacy-and-consent/how-do-i-turn-on-gdpr-functionality-in-my-hubspot-account; marketing-email/set-up-email-subscription-types · H21 hubspot.com/pricing/sales.
Observação: a página de preços da HubSpot lista no Starter itens (workflows limitados, 5 scores, 100 relatórios, sequences) que os artigos da central ainda marcam como Pro/Ent; a tabela usa a página de preços como embalagem atual.

RD Station (ajuda.rdstation.com/s/article/… salvo indicação; páginas renderizadas em Chromium headless porque a central não responde a fetch simples):
R1 Introdução-ao-RD-Station-CRM; Diferencas-entre-os-planos-Free-Basic-e-Pro · R2 Criar-e-editar-funis-de-vendas · R3 Cadastrar-motivos-de-perda; Configurar-motivos-de-perda-por-funil · R4 Como-integrar-o-RD-Station-Marketing-e-RD-Station-CRM; Usar-a-ação-de-Distribuir-Leads-Entre-os-Responsáveis; automacao-de-vendas; rdstation.com/planos/crm · R5 Criar-tarefas; Tipos-de-alertas-e-notificações-automáticas; Criar-configurar-e-acionar-gatilhos; Relatório-de-Atividades-de-vendas · R6 automacao-de-vendas; rdstation.com/planos/crm · R7 Histórico-de-Oportunidades · R8 Dúvidas-comuns-relativas-ao-WhatStation; Integração-com-o-WhatsApp-Web; integracao-contatos-mensagens-whatsapp-crm; Enviar-e-mails-via-RD-Station-CRM; Integracao-de-telefone-virtual-CRM · R9 Enviar-proposta-comercial; Cadastrar-apagar-ou-ocultar-produtos-e-serviços · R10 Criação-de-metas; Relatório-de-desempenho-X-metas · R11 Relatório-de-Pipeline; Relatórios-do-RD-Station-CRM · R12 Relatórios-do-RD-Station-CRM; Modelos-de-análise…Dashboards-Personalizados · R13 automacao-de-vendas; Criar-editar-e-excluir-Automação-de-Vendas; rdstation.com/planos/crm/advanced · R14 Configurar-qualificação-de-oportunidades; Priorização-inteligente-de-negociações · R15 Importar-base-de-dados; Criar-Empresas · R16 Criar-e-excluir-campos-personalizados · R17 Personalizar-a-visibilidade-de-cada-usuário; Definir-o-nível-de-permissão-de-usuários; Configurações-de-equipes · R18 Aplicativo-para-celular · R19 Integrar-o-RD-Station-CRM-com-o-Facebook-Lead-Ads-via-Pluga; Configure-a-API-Capi-CRM-do-Meta-Ads-no-RD-Station-Marketing; publicos-para-anuncios; rdstation.com/integracoes/conversoes-otimizadas-no-google-ads; Integrar-o-RD-Station-CRM-ao-Google-Agenda; Integrar-a-agenda-do-usuário-ao-calendário-do-Outlook; Integrar-o-RD-Station-CRM-com-o-RD-Station-Conversas · R20 Histórico-de-Oportunidades; Excluir-informações-e-registros-da-lixeira; Adequar-a-base-de-contatos-do-RD-Station-CRM-à-LGPD · R21 Histórico-de-Oportunidades; developers.rdstation.com/reference/crm-v1-get-deal (`deal_stage_histories`) · R22 rdstation.com/planos/crm.

Syonet (sem central de ajuda pública; material oficial de produto):
S1 syonet.com/pt-br/solucoes-crm; blog.syonet.com/blog/porque-o-crm-syonet-e-o-mais-completo-no-mercado · S2 solucoes-crm; materiais.syonet.com/crm-para-vendas; apps.apple.com/br/app/crm-syonet/id1090416158 · S4 solucoes-crm; materiais crm-para-vendas; blog gestao-de-leads-web-sua-concessionaria-faz-corretamente · S5 materiais novo-app-syonet; blog conheca-nosso-aplicativo-cic-mobile · S6 solucoes-crm; blog uso-de-fluxos-automatizados-na-gestao-de-leads; solucoes-marketing · S7 solucoes-crm; solucoes-chats · S8 solucoes-chats; blog integracao-com-centrais-telefonicas-voce-tem; solucoes-marketing · S9 solucoes-crm; blog crm-de-pecas-catalogo-digital-para-crescimento-de-vendas · S10 blog crm-de-pecas…; blog turbine-seu-time-de-telepecas · S12 blog indicadores-de-performance-no-dia-a-dia-da-sua-concessionaria; solucoes-marketing · S13 solucoes-crm; blog como-voce-faz-a-gestao-dos-leads-na-sua-concessionaria · S14 blog funil-de-vendas-acompanhe-a-evolucao-de-seus-leads; materiais novo-app-syonet · S15 blog syonet-crm-homologado-pela-hyundai-brasil · S17 blog syonet-de-olho-na-lgpd-o-que-estamos-fazendo; blog indicadores-de-performance… · S18 play.google.com/store/apps/details?id=com.syonet.mobile.crm; App Store id1090416158; materiais novo-app-syonet · S19 solucoes-marketing; solucoes-chats; developer.syonet.com (portal fechado) · S20 blog syonet-de-olho-na-lgpd…; blog conheca-o-portal-lgpd; lgpd.syonet.com · S21 syonet.com/pt-br; blog por-que-voce-precisa-de-um-crm-padrao-montadora; blog grupo-syonet-adquire-a-campos-dealer; syonet.com/pt-br/agende-uma-demonstracao. Linhas 3, 11 e 16 da Syonet: nada achado em fonte oficial.
