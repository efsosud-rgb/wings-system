# Cloudflare Workers AI (FLUX.1 schnell) — provedor de mídia

Imagens grátis dentro da franquia diária do Workers AI. Cobrança
`free_quota`: **R$ 0 por saída**, e a cota é contada **aqui**, no nosso
ledger (`CF_WORKERS_AI_DAILY_IMAGES`, padrão 50 por dia, fuso de São Paulo).
A Cloudflare nunca é perguntada quanto ainda resta; se o nosso número for
maior que a franquia real dela, ela recusa (429 → `quota`) e nada é cobrado.

Adaptador: `apps/api/src/modules/media/providers/cloudflare.ts`. Modelo no
catálogo: `cloudflare/flux-1-schnell`, "FLUX.1 schnell", imagem, formato só
1:1, até 4 saídas (uma chamada por saída), sem imagem de referência.

## O que o Eric precisa criar

1. Uma conta Cloudflare (a mesma do R2 serve). O **Account ID** está na página
   inicial do painel, à direita → `CF_ACCOUNT_ID`.
2. Um **API Token** (My Profile → API Tokens → Create Token) com a permissão
   **Workers AI: Read** (o template "Workers AI" já traz) → `CF_WORKERS_AI_TOKEN`.
3. Conferir na página de preços do Workers AI a franquia grátis do dia
   (10.000 "neurons"/dia em 2026) e ajustar `CF_WORKERS_AI_DAILY_IMAGES` para
   caber nela com folga. Passar da franquia com billing ligado **cobra**; sem
   billing, a Cloudflare só recusa.

## Como o adaptador fala (não verificado)

```
POST https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell
Authorization: Bearer {CF_WORKERS_AI_TOKEN}
{ "prompt": "...", "steps": 4 }
```

Resposta lida como `{ result: { image: "<base64>" }, success, errors[], messages[] }`;
se vier `image/*` cru, os bytes são o arquivo. Sem imagem na resposta, a geração
é `refused` com as palavras dela ("Resposta dela: …"). Timeout de 90 s por
chamada; conexão caída é `unknown` (a cota do dia continua contada, nada é
reenviado). Com mais de uma saída, cada chamada vai uma vez e uma falha depois
da primeira guarda o que veio.

## Não verificado

- [ ] Se o modelo aceita `width`/`height` (por isso o formato é só 1:1 hoje).
      Se aceitar, os formatos de anúncio entram e a cota passa a contar por
      tamanho.
- [ ] O nome do campo da imagem (`result.image`) e se é JPEG ou PNG. O tipo do
      arquivo é lido dos bytes, então qualquer um dos dois entra na biblioteca.
- [ ] Prompt negativo: não há campo; ele é ignorado neste provedor.
- [ ] O custo em "neurons" de uma imagem 1024×1024 em 4 passos, para calibrar
      `CF_WORKERS_AI_DAILY_IMAGES`.

## Primeiro teste real

Tipo Imagem, grupo "Cloudflare Workers AI", formato 1:1, quantidade 1. O botão
deve dizer **Gerar (R$ 0,00)**. Depois, em Integrações, a cota do dia deve
mostrar 1 de 50, e o log da API uma linha `provider answer shape` com
`tool: "cloudflare.run"`. Se a geração vier "Recusada" com "respondeu sem
imagem", o campo tem outro nome: o ajuste é no `imageFrom`/`find` do adaptador.
