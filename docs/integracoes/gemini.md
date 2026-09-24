# Gemini API (imagem) — provedor de mídia

Geração e edição de imagem pelo `gemini-2.5-flash-image`, **pago por uso**.

A tabela oficial do Google (ai.google.dev/gemini-api/docs/pricing, lida em
2026-09-24, "last updated 2026-09-24") diz **"Not available"** na camada
grátis para a saída de imagem de todos os modelos de imagem. O
`gemini-2.5-flash-image` custa **US$ 0,039 por imagem** na camada paga. No
staging, a 1ª chamada do dia foi recusada com 429 "You exceeded your current
quota". A camada grátis continua valendo para modelos de texto, que este
provedor não usa.

Por isso a cobrança é `per_use`: o preço no botão é `GEMINI_USD_PER_IMAGE`
(padrão 0,039) × `BRL_PER_USD`, conta no teto único `MEDIA_MONTHLY_BRL`, e o
roteamento só chega a ele por um clique (é o mais caro das imagens depois do
Kairogen). **Fica desativado** enquanto `GEMINI_BILLING_ENABLED` não for
`true`: o cartão de Integrações mostra "Pago por uso" e o motivo. Os limites
locais por dia (`GEMINI_DAILY_IMAGES`, padrão 50) e por minuto
(`GEMINI_IMAGES_PER_MINUTE`, padrão 5) continuam como freio nosso.

Se o Google recusar por cota (429), a geração fica `refused`, nada é
reenviado, e o texto nomeia a próxima opção mais barata que atende agora
(Cloudflare grátis ou créditos do Kairogen): estimar com ela é um clique.

Adaptador: `apps/api/src/modules/media/providers/gemini.ts`. Modelo no
catálogo: `gemini/gemini-2.5-flash-image`, "Gemini 2.5 Flash Image", imagem,
formatos 1:1, 4:5, 9:16 e 16:9, até 4 saídas (uma chamada por saída),
**edita** uma imagem da biblioteca (`uso_de_imagem: edit`): a imagem vai
inline, em base64, no mesmo pedido — nenhum link assinado é emitido.

## O que o Eric precisa fazer para ligar

1. Ligar o faturamento no projeto do Google da chave `GEMINI_API_KEY`.
2. Pôr `GEMINI_BILLING_ENABLED=true` no Coolify (e, se o preço mudar,
   `GEMINI_USD_PER_IMAGE`).

## Como o adaptador fala (não verificado)

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent
x-goog-api-key: {GEMINI_API_KEY}
{ "contents": [{ "parts": [{ "text": "<prompt>\n\nDo not include: <negativo>" },
                           { "inlineData": { "mimeType": "image/png", "data": "<base64>" } }] }],
  "generationConfig": { "responseModalities": ["IMAGE"], "imageConfig": { "aspectRatio": "9:16" } } }
```

Resposta: a primeira parte com `inlineData.data` (ou `inline_data`) em
`candidates[].content.parts[]` é a imagem. Sem imagem (o modelo respondeu em
texto, um bloqueio de segurança), a geração é `refused` com as palavras dele.
Timeout de 120 s; conexão caída é `unknown`.

## Não verificado

- [ ] O nome exato do modelo na API (`gemini-2.5-flash-image`) e se a chave
      grátis o alcança.
- [ ] `imageConfig.aspectRatio`: se aceita `4:5` (a lista pública traz 1:1, 3:4,
      4:3, 9:16, 16:9 e outras).
- [ ] O tamanho da imagem devolvida por formato (a biblioteca lê dos bytes).
- [ ] Os limites reais da camada grátis por minuto e por dia; os nossos são
      chutes conservadores.
- [ ] Se `responseModalities: ["IMAGE"]` sozinho basta ou se o modelo exige
      `["TEXT", "IMAGE"]` (nesse caso a resposta traz texto e imagem, e o leitor
      já pega a imagem).

## Primeiro teste real

Tipo Imagem, grupo "Gemini", formato 4:5, quantidade 1, sem imagem de
referência. Botão **Gerar (R$ 0,00)**. Depois, um segundo teste com "Enviar
arquivo" + "Editar esta imagem" e um prompt curto ("replace the background
with light grey"). Em Integrações a cota deve mostrar 2 de 50 no dia e o log
duas linhas `gemini.generateContent`.
