# Entrada de leads: conversões do RD Marketing → negócios no RD CRM

Job `expansion-intake` (agendador dentro da API, a cada 5 minutos). Lê as
conversões novas do RD Marketing e cria o negócio que faltar no RD CRM.

| Conversão (`conversion_identifier`) | Funil / etapa |
| --- | --- |
| página de marca-cliente da lista (Integrações → Entrada de leads de Expansão) | Expansão / "Novo Contato", marca em "Nome da Marca", dono e tarefa "Fazer primeiro contato" (vence no dia) |
| `wings-company-form-site` | Formatação / "Sem contato" |
| qualquer outra | nada (contada como ignorada) |

O que vai no negócio: nome, e-mail e telefone da conversão, campo "Nome da Marca"
(Expansão), campo "OBS" com UTMs, página e identificador (o RD CRM não tem campos
de UTM), origem "Referência | <host da LP>" quando existe no RD, senão "Contato
pelo Site", e a campanha "LP/LE <marca> - Fluxo Expansão" quando existe.

## Regras

- **Sem duplicar:** antes de criar, busca o contato no CRM por e-mail e telefone.
  Negócio aberto em qualquer funil, ou negócio criado depois da conversão (mesmo
  fechado), cobre a conversão. Um contato que converte três vezes gera um negócio.
- `expansion_intake_ledger` guarda a chave de cada conversão decidida (uuid do
  contato + identificador + momento; nada pessoal). Uma conversão decidida não é
  reavaliada, então um negócio perdido não renasce.
- Uma criação por conversão, sem repetir na mesma passada: uma resposta perdida é
  pega pela checagem de duplicidade da próxima. Depois de criar, o negócio é lido
  de volta; sem contato ou sem origem, conta em `unverified`.
- Só cria. Não altera fluxos do RD, a "Integração RD Station Marketing" nem
  negócios existentes. Log e terminal: só contagens.
- Ligado por `EXPANSION_INTAKE_ENABLED=true` (padrão desligado) mais os quatro
  `RD_CRM_API_TOKEN`, `RD_MKT_*`. Janela de 48 h por passada.

## Verificado ao vivo em 2026-09-28

Segmentação "Todos os contatos da base de Leads" (13942586) lista todos os
contatos (125 por página, sem ordenação; percorrida inteira, ~16 s para 4 mil).
Eventos do contato trazem `payload.conversion_identifier` e `traffic_source`.
`/contacts?email=` e `?phone=` devolvem o contato com os negócios dentro.
`POST /deals`: `deal_source` e `campaign` são objetos `{ _id }` no topo do corpo
(`deal_source_id`/`campaign_id` dentro de `deal` são ignorados em silêncio).

**Não verificado:** criar negócio para contato que já existe no CRM (o vínculo por
`contacts: [{ _id }]` não funciona; agora o contato vai inteiro e o RD casa por
e-mail — conferir na primeira criação real, `unverified` avisa); dono do negócio
(Expansão: `EXPANSION_OWNER_RD_USER_ID`, id do usuário no RD CRM, vai em `deal.user_id`; Formatação fica sem dono; `distribution_settings` do RD não foi testado).

## Auditoria de conversões (somente leitura)

`GET /expansion/landing-audit?days=90` (permissão `integrations.manage`) percorre as
conversões do RD Marketing dos últimos N dias (1 a 120) e cruza com os negócios do RD
CRM. Só GET no RD (a única exceção é o POST de renovação do token OAuth); não cria nem
altera nada. A primeira chamada inicia a varredura e responde **202**; as seguintes
respondem `running` até terminar e então o resultado (`refresh=1` refaz). Uma varredura
por vez, guardada só na memória do processo. Sem credenciais do RD: 503.

A resposta traz apenas contagens, identificadores de conversão, nomes de funil e etapa e
nomes de campanha: por identificador, conversões, pessoas, quantas viraram negócio (por
"Funil / Etapa") e quantas vazaram; e a lista de hoje (fuso de São Paulo) com plataforma
(gclid/fbclid/utm_source), tipo de evento, horário e um número por pessoa. Nunca nome,
e-mail nem telefone. `registered` lista as páginas ativas da tabela
`expansion_landing_pages`, para achar as que não tiveram conversão. O RD não expõe uma
lista de landing pages pela API, então "página sem conversão" é a cadastrada sem conversão.

## Recuperação de conversões sem negócio

Tela: Integrações → "Recuperar conversões sem negócio (30 dias)" (`integrations.manage`).
API: `GET/POST /expansion/landing-recovery`. Duas etapas, impostas pelo servidor:

1. `POST { dryRun: true, days }` lê o RD e diz quantos negócios criaria. Não escreve nada.
2. `POST { dryRun: false, planId, expectedCreated }` só vale se aquela simulação terminou há
   menos de 2 h e o número confirmado é o que ela previu; a simulação autoriza uma execução.

Escopo fixo: `wings-company-form-site`, `lp-formatacao-whatsapp` e `Formulário Simplificado. -02`
→ Formatação / Novo Contato (sem dono); `lp-calcadao-do-frango` → Expansão / Novo Contato, dono
`EXPANSION_OWNER_RD_USER_ID`, com a tarefa "Fazer primeiro contato". `fluentform_3` só é contado.
Mesma regra de cobertura do job (negócio aberto, ou criado depois da conversão, cobre; nunca
duplica) e o mesmo `expansion_intake_ledger`. A resposta e a auditoria (`expansion.recovery_*`)
têm contagens e ids de negócio, nunca dado pessoal.
