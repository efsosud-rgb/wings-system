# Higgsfield — provedor de mídia

Imagem (Soul) e imagem→vídeo (DoP) pela API por uso do Higgsfield, cobrada em
**dólar**. Cobrança `per_use`: o último degrau do failover, e o único que o
sistema nunca escolhe sozinho no lugar de um mais barato.

Adaptador: `apps/api/src/modules/media/providers/higgsfield.ts`. Modelos:

| Chave              | Nome                              | Tipo  | Formatos             | Saídas | Observação                                       |
| ------------------ | --------------------------------- | ----- | -------------------- | ------ | ------------------------------------------------ |
| `higgsfield/soul`  | Higgsfield Soul                   | image | 1:1, 4:5, 9:16, 16:9 | 1      | sem imagem de referência                         |
| `higgsfield/dop`   | Higgsfield DoP (imagem para vídeo)| video | 9:16, 16:9, 1:1      | 1      | **exige** primeiro quadro; durações 5 s e 10 s   |

## O preço que aparece antes do clique

O Higgsfield não publica o custo num formato que o sistema consiga ler, então
o que a tela mostra é a **expectativa configurada**, convertida por
`BRL_PER_USD` (padrão 5,5) e arredondada para cima:

- imagem: `HIGGSFIELD_USD_PER_IMAGE` (padrão 0,05) → R$ 0,28;
- vídeo: `HIGGSFIELD_USD_PER_VIDEO_SECOND` (padrão 0,10) × duração → 5 s = R$ 2,75.

Se a resposta informar o custo real (`cost_usd`, `cost`, `price`,
`credits_used`), a linha final do ledger corrige pela diferença. Ajuste as
duas variáveis assim que a primeira fatura mostrar o valor real.

**Saldo:** o cartão em Integrações tenta `GET /v1/credits` e mostra o primeiro
número que achar sob `balance_usd`, `usd`, `balance`, `credits`,
`credit_balance` ou `remaining`, em dólar e em reais; sem número, "saldo não
informado". Saldo zero deixa o provedor indisponível.

## O que o Eric precisa criar

1. Conta no Higgsfield com a **API por uso** habilitada (cloud/platform) e
   crédito carregado em dólar.
2. A chave da API → `HIGGSFIELD_API_KEY`. Se o painel entregar também um
   segredo, → `HIGGSFIELD_API_SECRET` (vai no cabeçalho `hf-secret`).
3. Anotar o preço por imagem Soul e por segundo de vídeo DoP no plano, e
   informar `HIGGSFIELD_USD_PER_IMAGE` e `HIGGSFIELD_USD_PER_VIDEO_SECOND`.

## Como o adaptador fala (não verificado)

```
POST https://platform.higgsfield.ai/v1/text2image/soul
hf-api-key: …   hf-secret: …
{ "params": { "prompt": "...", "aspect_ratio": "4:5", "quality": "basic", "negative_prompt": "..." } }

POST https://platform.higgsfield.ai/v1/image2video/dop
{ "params": { "prompt": "...", "input_image": { "type": "image_url", "image_url": "<link assinado, 15 min>" }, "duration": 5 } }

→ { "id": "...", "status": "queued" }
GET  https://platform.higgsfield.ai/v1/requests/{id}
→ { "status": "in_progress" | "completed" | "failed" | "nsfw", "results": { "raw": { "url": "https://…" }, "min": { "url": "…" } } }
```

O primeiro quadro é entregue por link assinado nosso de 15 minutos (ou pelo
endereço pré-assinado do R2), como no Kairogen. A saída é baixada do endereço
`https` que vier em `results` (o `raw` antes do `min`), até 150 MB. Estados
lidos como concluído: `completed`, `succeeded`, `success`, `done`, `finished`;
como falha: `failed`, `error`, `nsfw`, `canceled`, `rejected`. Timeout de 60 s
no envio (queda é `unknown`: o gasto fica contado e nada é reenviado).

## Não verificado

- [ ] O endereço base e os caminhos (`/v1/text2image/soul`,
      `/v1/image2video/dop`, `/v1/requests/{id}`, `/v1/credits`).
- [ ] Os nomes dos cabeçalhos de autenticação.
- [ ] O envelope `{ params: … }` e os nomes `aspect_ratio`, `quality`,
      `input_image`, `duration`.
- [ ] Se o DoP aceita 5 e 10 s, e se existe texto→vídeo sem imagem.
- [ ] O formato de `results` e se a resposta informa custo.
- [ ] Se o Soul aceita imagem de referência (hoje `uso_de_imagem: null`).

## Primeiro teste real

Só depois de os grátis e o Kairogen estarem esgotados **ou** de propósito:
tipo Imagem, grupo "Higgsfield", 1:1, quantidade 1. O botão deve dizer
**Gerar (R$ 0,28)** (ou o que as variáveis disserem). Conferir depois: a
fatura do Higgsfield, o `brl_cents_charged` da linha final do ledger, e a
linha `higgsfield.soul` / `higgsfield.request` no log. Se o "Saldo" vier
"não informado", ler a forma de `higgsfield.credits` no log e acertar o
leitor.
