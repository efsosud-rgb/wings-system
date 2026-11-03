# 0012 — O que gasta dinheiro ou manda mensagem nasce desligado

- **Data:** 30/10/2026 (manhã)
- **Quem decidiu:** Eric
- **Situação:** em vigor
- **Fonte:** `/opt/hermes/entrada/decisoes-2026-10-30.md` ("Funções que gastam dinheiro ou mandam mensagem sobem
  desligadas na produção; o Eric liga uma por vez, depois do teste"); `AGENTS.md`, seção 3 ("Ads, messages and money");
  `/opt/hermes/entrada/decisoes-2026-10-29.md` (alerta por e-mail ligado primeiro no staging, produção só com o Eric)
- **Onde conferir:** chaves `*_ENABLED` do `.env.example` (vazias ou `false`), `ADS_WRITES_ENABLED=false`, o switch
  `official_number_live` do WhatsApp (`docs/whatsapp/cloud-api.md`), `docs/ads/travas.md`,
  `docs/integracoes/provedores-de-midia.md`

## Contexto

Uma função nova pode gastar dinheiro (anúncio, crédito de mídia, API paga) ou mandar mensagem para lead, cliente ou
funcionário. Ligada por engano, o dano não volta atrás.

## Decisão

- Toda função que gasta dinheiro ou manda mensagem sobe desligada na produção. O Eric liga uma por vez, depois do teste.
- O que o sistema cria numa plataforma de anúncio nasce pausado; ligar é ato de uma pessoa.

## Motivo

Ligar uma por vez, depois do teste, para ver o efeito de cada uma antes da próxima.

## Consequências

- Função nova desse tipo vem com uma chave (variável `*_ENABLED` ou switch) desligada por padrão; sem a chave ou sem a
  credencial, a tela diz que está desligada e nada é simulado, como já fazem o WhatsApp e o envio ao WordPress.
- Exemplo de 29/10: o alerta de primeiro contato por e-mail (`CRM_ESCALATION_EMAIL_ENABLED`) ligou primeiro no staging,
  com lead de teste; na produção, só com o Eric.
- Gasto de crédito de mídia só com o clique de uma pessoa num preço estimado antes; chamada que pode ter custado nunca é
  repetida.
- Agente nunca manda mensagem nem liga sem um pedido para aquele envio; testes e scripts não mandam.
- Mensagens para clientes, leads ou funcionários são do Eric (`/opt/agentes/politica.md`).
