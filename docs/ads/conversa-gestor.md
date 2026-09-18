# Conversa com o gestor de tráfego — antes de 30/09/2026

O gestor sai no fim de setembro. Duas coisas só ele pode dar: o **veredito
sobre os alertas** que dispararam com dado real pela primeira vez, e a
**rotina dele por escrito**. Uma hora, olhando o cockpit e o Gerenciador lado a
lado.

## 1. Gerar a folha dos alertas

No terminal da API de staging:

```
node dist/modules/ads/ops-cli.js alerts > alertas.md
```

Sai um bloco por alerta aberto, do mais grave para o mais leve e, dentro dos
de desgaste, da maior frequência para a menor. Cada bloco traz: o alerta, a
campanha (nome, ID, status, onde mora o orçamento), o conjunto, o anúncio (nome,
ID, status efetivo), a frequência estimada com limiar e pico diário, o volume
(impressões, maior alcance diário, gasto na janela), desde quando está aberto,
e um espaço para o veredito: **verdadeiro / falso / depende — e por quê**.

> Em 18/09 o cockpit mostrava 7 alertas: 6 de desgaste de criativo (frequência
> entre 3,0 e 11,3) e 1 de ritmo de gasto. A folha não está neste repositório
> de propósito: é dado vivo, e gerá-la na véspera garante que ele opine sobre o
> que está aberto _naquele dia_.

## 2. A pergunta que mais importa: a frequência está certa?

A frequência do alerta é uma **estimativa, e um limite superior**: impressões
da janela ÷ maior alcance diário (ver [alerts.md](alerts.md)). Como o alcance
de dias diferentes se sobrepõe muito, o número real é menor — às vezes bem
menor. **Um 11,3 nosso pode ser um 4 no Gerenciador.**

Para cada alerta de desgaste, o gestor abre o anúncio no Gerenciador, período
"últimos 7 dias", coluna **Frequência**, e o número vai para a linha
"Frequência de 7 dias no Gerenciador" da folha. Com seis pares
(estimada × real) dá para decidir com dado:

- se a razão for estável, o limiar sobe na mesma proporção;
- se variar muito, a estimativa não serve e vale buscar a frequência da janela
  direto da API da Meta (uma chamada de insights com janela de 7 dias, sem
  quebra diária).

## 3. Perguntas por alerta

**Desgaste de criativo**

- Com essa frequência, _neste_ público, você já teria trocado o criativo? Qual
  é o seu número de corte — e ele muda entre público frio e remarketing?
- O que você olha junto com a frequência antes de agir? (CTR caindo, CPL
  subindo, comentários negativos…)
- Quando age, faz o quê: pausa o anúncio, troca o criativo, amplia o público?
- Frequência 3,0 é cedo demais para avisar? Avisar cedo é o lado certo de
  errar, mas um alerta que sempre se ignora ensina a ignorar todos.

**Ritmo de gasto**

- A régua é gasto uniforme no mês, ±20%. A Wings gasta uniforme? Ou concentra
  em lançamentos, início de mês, fim de semana?
- Acima ou abaixo da linha: qual dos dois preocupa mais, e o que você faria?

## 4. A rotina dele, por escrito

É o que mais se perde quando alguém sai, e o que mais vale para decidir o que o
sistema deve vigiar sozinho.

- O que você olha **todo dia**, e em que ordem? E toda semana?
- Quais números te fazem mexer em orçamento — para cima e para baixo? Em que
  passo (10%? 20%?) e com que intervalo entre mexidas?
- Quais campanhas são "não toque" e por quê?
- O que já deu errado nesta conta que alguém novo repetiria? (As duas
  reprovações por "Práticas de negócios inaceitáveis" — o que houve?)
- As outras três contas do BM (Rec Lab | Boleto, Venda de Franquia, Leads
  Formatação): alguma volta a veicular? Quando, e com que verba?
- O `spend_cap` de R$ 2.500 da Fly High: quem define, e quando muda?
- Acessos: quem mais tem papel de anunciante/admin no BM? O que depende do
  _seu_ usuário pessoal (tokens, formas de pagamento, páginas)?

A última pergunta é a mais urgente de todas: **se o token de escrita do
sistema foi gerado pelo usuário dele, ele morre quando o acesso dele for
removido.** Confirme antes da saída e, se for o caso, gere o token por um
usuário de sistema do BM.

## 5. Escolher a campanha da primeira escrita

Feche a conversa escolhendo, com ele, a campanha do teste — ver
[primeira-escrita.md](primeira-escrita.md). Uma que ele pausaria de qualquer
forma, ou uma pequena, de gasto baixo. Anote o ID.

## Depois

As respostas viram: ajuste de `DEFAULT_ALERT_CONFIG`
(`apps/api/src/modules/ads/alerts.ts`), e um `docs/ads/rotina-do-gestor.md` com
a seção 4. Traga a folha preenchida — o ajuste dos limiares sai dela.
