# Cockpit e alertas (Etapa 6.6)

O cockpit é a tela de leitura do tráfego pago: desempenho por campanha, ritmo
de gasto do mês e a fila de alertas abertos. **Abrir o cockpit não chama a
Meta, não gasta e não altera nada** — tudo vem do que o job de ingestão já
espelhou. A única ação disponível é marcar um alerta como visto.

Rota: `/trafego-pago` (aprovações continuam em `/trafego-pago/aprovacoes`).
Permissão: `ads.read`.

## As cinco regras

| Regra                   | Dispara quando                                    | Gravidade | Aviso no WhatsApp | Estado                   |
| ----------------------- | ------------------------------------------------- | --------- | ----------------- | ------------------------ |
| `ad_rejected`           | anúncio com `effective_status = DISAPPROVED`      | crítico   | ✅ sim            | ativa                    |
| `budget_pacing`         | gasto ±20% fora da linha de gasto uniforme do mês | atenção   | não               | ativa                    |
| `creative_fatigue`      | frequência estimada ≥ 3,0 em 7 dias               | atenção   | não               | ativa                    |
| `quality_below_average` | `quality_ranking` em `BELOW_AVERAGE_*`            | atenção   | não               | ativa, **dormente**      |
| `conversion_silence`    | ≥ R$ 50,00 em 24h sem nenhuma conversão           | crítico   | ✅ sim            | **desligada por padrão** |

Configuração em `DEFAULT_ALERT_CONFIG` (`apps/api/src/modules/ads/alerts.ts`).

### Por que duas regras não produzem nada hoje

- **`quality_below_average` está dormente**: a Meta devolve `UNKNOWN` abaixo do
  seu limiar de impressões, e esta conta está muito abaixo dele. A regra fica
  armada e passa a funcionar sozinha quando o volume subir. Não custa nada
  mantê-la ligada.
- **`conversion_silence` está desligada**: o spike da Etapa 6.0 mostrou que a
  conta **nunca registrou um evento de lead**. Ligada, ela dispararia em tudo e
  ensinaria a equipe a ignorar alertas. Está construída e testada, esperando a
  primeira campanha de formulário entregar. Para ligar, basta
  `conversionSilence: { enabled: true }`.

### O que a regra de desgaste realmente mede

As linhas guardadas são diárias, então a frequência da janela é **estimada**:
impressões da janela ÷ maior alcance diário. O alcance diário se sobrepõe muito,
então esse número é um **limite superior** da frequência real — a regra erra
para o lado de avisar cedo, que é o lado certo para um aviso que uma pessoa lê
antes de agir. O valor diário máximo também fica no detalhe do alerta.

### O que a regra de ritmo compara

A referência é o orçamento **utilizável** (70% do teto) distribuído
uniformemente pelo mês. É uma linha de planejamento, não uma promessa: campanhas
começam e param. Por isso a regra só dispara fora de ±20%, nunca nos primeiros
~3 dias do mês, e **não chama de "atrasada" uma conta sem nada comprometido** —
uma conta parada não está atrasada, está parada.

## Deduplicação e ciclo de vida

Existe no máximo **um alerta aberto por (conta, regra, entidade)**, garantido
por índice único parcial. Uma condição que persiste atualiza `last_seen_at`;
não gera um alerta novo a cada hora. Quando a condição deixa de valer, o alerta
é resolvido sozinho (`resolved_at`) e some da fila.

"Marcar como visto" (`acknowledged_at`) registra que alguém olhou — **não
resolve**. Um anúncio reprovado continua reprovado depois de visto.

## Notificação

Só alertas **críticos** vão para o WhatsApp, pelo mesmo canal Z-API e para as
mesmas três pessoas das aprovações (Admin Master + Diretoria). Os demais ficam
no cockpit. A mensagem descreve e dá o link; **não oferece nenhuma ação** —
nada que mexa em dinheiro acontece fora do portão de aprovações.

Falha de envio não perde o alerta: o registro já está gravado, o erro fica em
`notification_error`, `notified_at` continua nulo e a próxima execução tenta de
novo. A tela mostra a falha explicitamente, em vez de parecer entregue.

## Execução

O job horário (`ingest-cli`) roda a detecção logo após a ingestão, por conta:

```
node dist/modules/ads/ingest-cli.js --days 7
```

Saída típica:

```
  alertas: 2 detectados (2 novos, 0 resolvidos), 1 notificados
```

## Limites conhecidos

- A janela de 24h da regra de conversão é aproximada por dias inteiros, porque
  as linhas guardadas são diárias.
- O cockpit mostra uma conta por vez (`?accountId=`); hoje só existe a Meta.
- Não há view de calendário ainda — as campanhas já trazem `start_time`/
  `stop_time` da Meta, mas a tela fica para depois.
