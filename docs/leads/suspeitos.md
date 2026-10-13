# Lead suspeito de robô

Desde 13/10/2026 (ordem do orquestrador, aprovada pelo Eric). Em outubro, um robô encheu a página da Grupo Forte Fênix com pessoas inventadas, mandadas em rajadas.

## A regra

Um lead é marcado como suspeito quando tem os dois sinais abaixo e mais pelo menos um dos outros dois:

1. **E-mail do robô:** `nome.sobrenome` + 10 dígitos `@gmail.com`, e os dígitos não são o telefone da pessoa.
2. **DDD de capital:** 11, 21, 31, 41, 51, 61, 81, 85 ou 91.
3. **Rajada:** 4 envios ou mais em até 3 minutos na mesma página. Quando a página não é conhecida, como num negócio copiado do RD CRM, conta a mesma fonte.
4. **Tráfego Direto:** sem UTM, clique de anúncio, página de origem nem anúncio. É o que o RD chama de "Tráfego Direto".

O código fica em `apps/api/src/modules/leads/suspect.ts`; os textos dos motivos, em `LEAD_SUSPECT_REASONS` (`packages/shared`).

## O que acontece

- A marca é conferida na chegada de cada lead. O quarto envio de uma rajada marca também os três anteriores.
- A ficha mostra a faixa "Lead suspeito de robô", com os motivos e a hora da marca.
- **Nada é apagado, fechado nem marcado como perdido.** Quem decide é o vendedor:
  - se for robô, marca a perda como em qualquer negociação;
  - se não for, clica em **Não é robô**. A marca sai da ficha, os motivos ficam guardados e a ação vai para a auditoria (`lead.suspect_cleared`).
- Um lead em que alguém já tirou a marca não é marcado de novo.
- Cada marca grava o evento `lead.suspect_marked` no lead.

## Os leads que já estavam no banco

A migração `0088_lead_suspect_backfill.sql` aplicou a mesma regra uma vez, em 13/10, a todos os leads existentes. No staging foram 22 leads: 16 da página `grupo-forte-fenix` e 6 copiados do RD CRM em 03 e 04/10. O teste `suspect.test.ts` confere que a migração e o código marcam os mesmos leads.

## Para conferir sem dado pessoal

`wings-staging-sql "select suspect_reasons, count(*) from lead_origin_analysis where suspect_at is not null group by 1"`
