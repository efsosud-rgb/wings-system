# 0008 — Instagram, Google e TikTok só pela via oficial de cada plataforma

- **Data:** 29/10/2026 (Instagram, Google e TikTok); 30/10/2026 (app da Meta para o Instagram)
- **Quem decidiu:** Eric
- **Situação:** em vigor; a prospecção pelo Instagram está em construção (tarefas ig01 a ig04)
- **Fonte:** `/opt/hermes/entrada/decisoes-2026-10-29.md` (Prospecção Instagram, Prospecção Google, TikTok);
  `/opt/hermes/entrada/decisoes-2026-10-30.md` ("Prospecção Instagram: as permissões do Instagram vão para o app Wings
  Traffic Agent"); `docs/decisoes.md` (linha de 29/10); `docs/prospeccao/instagram.md`
- **Onde conferir:** `docs/prospeccao/`, `apps/api/src/modules/prospecting/`

## Contexto

A prospecção quer achar empresas no Instagram e no Google e receber leads de outras redes. Raspar páginas ou usar
sessão logada viola os termos das plataformas e a LGPD.

## Decisão

- Instagram: só pela via oficial (webhook de comentários dos posts e anúncios da Wings com uma resposta privada;
  comentários de concorrentes colados pela vendedora, que aborda à mão; Business Discovery nas empresas do Google).
  Proibidos raspagem, sessão logada, extensão, copiar telefone de bio e WhatsApp sem permissão.
- As permissões do Instagram ficam no app Wings Traffic Agent, com token só de Instagram e sem permissão de anúncio; o
  app Wings CRM Vendas não é mexido.
- Google: Places API com chave restrita e faturamento com teto baixo, só no staging; contato real com empresa só depois
  do Jurídico.
- TikTok: pela Zapier se o plano atual já tiver Webhooks; se precisar assinar algo novo, esperar o app oficial.

## Motivo

Prospectar sem violar os termos das plataformas nem a LGPD (`docs/decisoes.md`, 29/10).

## Consequências

- Integração nova com plataforma usa a API oficial dela; caminho não oficial precisa de decisão do Eric.
- Quando a plataforma troca de API, o caminho oficial novo é seguido (lições 9 e 10 de [`../licoes.md`](../licoes.md):
  Data Manager API no Google Ads; Embedded Signup v4 na Meta).
