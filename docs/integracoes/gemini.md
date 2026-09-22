# Gemini API (imagem) — provedor de mídia

Geração e edição de imagem pelo `gemini-2.5-flash-image`, na camada grátis da
API do Google. Cobrança `free_quota`: **R$ 0 por saída**, com cota **local**
por dia (`GEMINI_DAILY_IMAGES`, padrão 50) e por minuto
(`GEMINI_IMAGES_PER_MINUTE`, padrão 5), contadas no ledger, mais baixas que
as do Google para recusar antes dele.

Adaptador: `apps/api/src/modules/media/providers/gemini.ts`. Modelo no
catálogo: `gemini/gemini-2.5-flash-image`, "Gemini 2.5 Flash Image", imagem,
formatos 1:1, 4:5, 9:16 e 16:9, até 4 saídas (uma chamada por saída),
**edita** uma imagem da biblioteca (`uso_de_imagem: edit`): a imagem vai
inline, em base64, no mesmo pedido — nenhum link assinado é emitido.

## O que o Eric precisa criar

1. Uma chave em **Google AI Studio** (aistudio.google.com → Get API key), num
   projeto **sem billing** se a intenção é ficar na camada grátis →
   `GEMINI_API_KEY`.
2. Se o projeto tiver billing ligado, cada imagem é cobrada pelo Google no
   preço publicado (cerca de US$ 0,04 em 2026) e **este sistema continuará
   mostrando R$ 0**, porque trata a chave como grátis. Nesse caso, ou use um
   projeto sem billing, ou peça para tratar o Gemini como pago por uso (é uma
   linha de configuração no adaptador).

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
