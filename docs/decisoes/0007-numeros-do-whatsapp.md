# 0007 — Números das vendedoras em coexistência; número próprio, só da API, para a Sofia

- **Data:** 30/10/2026, 13h58
- **Quem decidiu:** Eric
- **Situação:** em vigor; substitui a linha de 27/10 de `docs/decisoes.md` que punha a Sofia num número em coexistência
- **Fonte:** `/opt/hermes/entrada/decisoes-2026-10-30.md` ("Números do WhatsApp (13h58)"); lição 8 de
  [`../licoes.md`](../licoes.md); `docs/whatsapp/cloud-api.md` e `docs/whatsapp/conectar-numero.md`
- **Onde conferir:** tabela `wa_numbers` (migração 0095) e o token por número; `apps/api/src/modules/whatsapp/calling.ts`

## Contexto

As vendedoras atendem pelos números de trabalho no app do celular. A Meta permite ligar o mesmo número ao app e à API
ao mesmo tempo (coexistência), mas nesse modo a API de chamadas não funciona.

## Decisão

- Os 3 números de trabalho das vendedoras entram em coexistência: continuam no celular e ficam espelhados no sistema,
  com texto, arquivo e áudio enviados pelo sistema.
- A ligação pelo número da vendedora fica no celular (limite da Meta para coexistência).
- Um número novo, só da API oficial, fica com a Sofia, os modelos e as ligações pelo sistema. Quando ele chegar, os
  botões do site passam para ele.

## Motivo

Manter o app do celular das vendedoras funcionando e, ao mesmo tempo, ter um número em que a API de chamadas funciona.

## Consequências

- Cada número tem o próprio token; a mensagem guarda de qual número veio e a cópia usa o token desse número.
- Ligação pelo sistema só sai pelo número que está só na API.
- Números de telefone não entram em registros, commits nem relatórios: cite o número pelo id em `wa_numbers`.
