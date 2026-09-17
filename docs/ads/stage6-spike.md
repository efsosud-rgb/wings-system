# Etapa 6.0 — spike de métricas (somente leitura)

Executado contra a conta real `act_339488762500182` com o token de leitura.
Nenhum objeto foi criado, alterado ou gasto.

## Resumo executivo

A infraestrutura de métricas da Meta responde normalmente, mas **esta conta
quase não tem dados**: nenhuma entrega em 2026 e apenas 3 campanhas com dados
em 2025. Mais importante: **nenhum evento de lead foi registrado em nenhuma
janela consultada**, embora as campanhas se chamem "LEAD | FORMS".

Isso não impede construir o cockpit — impede que ele mostre algo útil hoje.

## 1. Disponibilidade dos campos

| Campo                                                                       | Situação                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------- |
| `spend`, `impressions`, `clicks`, `ctr`, `cpc`, `cpm`, `reach`, `frequency` | ✅ retornados                                           |
| `actions`, `cost_per_action_type`                                           | ✅ retornados (quando há entrega)                       |
| `quality_ranking`, `engagement_rate_ranking`, `conversion_rate_ranking`     | ⚠️ retornam `UNKNOWN` — volume abaixo do limite da Meta |
| `time_increment=1` (diário)                                                 | ✅ funciona, com paginação                              |
| `action_attribution_windows`                                                | ✅ aceito                                               |
| `budget_remaining` (campanha)                                               | ✅ retornado                                            |
| `start_time` / `stop_time`                                                  | ✅ 9 campanhas têm agenda (view de calendário viável)   |
| `x-business-use-case-usage`                                                 | ✅ presente; uso atual 0%                               |

## 2. Volume de dados histórico

| Janela            | Linhas (campanha) |
| ----------------- | ----------------- |
| 2026-01-01 → hoje | **0**             |
| 2025              | 3                 |
| 2024              | 0                 |

Amostra de 2025: `spend=42,15` `ctr=1,43%` `frequency=1,27`.

## 3. ⚠️ Nenhum lead registrado

Tipos de ação reportados em 2025, por volume:

```
post_engagement 751 · page_engagement 751 · video_view 715
link_click 27 · post_reaction 9 · onsite_conversion.post_net_like 9
```

**Não há `lead`, `offsite_conversion.fb_pixel_lead` nem qualquer ação de
formulário.** Consequências diretas:

- **CPL e CPA não podem ser calculados** a partir do histórico desta conta;
- o alerta de "silêncio de conversão" (item 15) **não tem linha de base**:
  tudo seria silêncio;
- a decisão sobre "qual ação conta como lead" fica em aberto até existir ao
  menos uma campanha de formulário entregando.

## 4. Saúde da conta e reprovações

- `account_status = 1 (ACTIVE)`, `disable_reason = 0 (NONE)`, conta com 468
  dias. **A conta não está desabilitada.**
- 13 anúncios: `WITH_ISSUES=4`, `DISAPPROVED=2`, `PAUSED=3`,
  `CAMPAIGN_PAUSED=2`, `ADSET_PAUSED=2`.
- `issues_info` (4 anúncios) traz sempre o mesmo código **2643145 —
  "Restrição da conta. Tente novamente mais tarde."**
- `ad_review_feedback` ✅ funciona e traz o motivo real da reprovação. Nos 2
  anúncios reprovados: **"Práticas de negócios inaceitáveis"** — violação de
  Padrões de Publicidade, não um problema técnico.

**Para o item 17, o campo certo é `ad_review_feedback`, não `issues_info`.**
`issues_info` está vazio justamente nos anúncios reprovados.

## 5. Limitações do token de leitura

O token `ads_read` lê `account_status`, `disable_reason`, `name`, `age` e
`funding_source_details`, mas **não** lê `business{name}` (`#10 Permission
Denied`). Pedir um campo negado derruba a resposta inteira, então cada campo
sensível deve ser pedido isoladamente ou removido da lista.

## 6. Consequências para 6.1 / 6.6

1. A ingestão de métricas deve funcionar com **zero linhas** sem parecer
   quebrada — o estado normal desta conta hoje é "sem dados".
2. CPL/CPA ficam como colunas vazias até existir entrega com conversão; nada
   de inventar um número a partir de `link_click`.
3. O alerta de conversão só faz sentido depois que **alguma** campanha de
   formulário entregar. Até lá, fica desligado por padrão.
4. Vale expor de imediato o que já existe e tem valor: **anúncios reprovados
   com o motivo real** e o ranking de qualidade quando sair de `UNKNOWN`.
5. Rankings de qualidade não estarão disponíveis nos volumes atuais
   (R$15–31/dia).
