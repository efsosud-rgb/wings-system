# `create_campaign` — a campanha de sacrifício

Onda 3, 18/09/2026. **Nada aqui foi verificado contra a Meta**: o código foi
exercitado só com o cliente falso e com `fetch` roteirizado.
`ADS_WRITES_ENABLED` não foi tocada.

> ⚠️ **Desde a Onda 6 (19/09/2026) executar cria também o conjunto de anúncios e
> os anúncios**, tudo pausado — ver [meta-conjunto-anuncios.md](meta-conjunto-anuncios.md).
> O que este arquivo diz sobre "só a casca", "nenhuma imagem vai para a Meta" e
> "nasce ativa" vale apenas para pedidos aprovados antes disso.
>
> O mesmo caminho vale para o Google (Pesquisa e YouTube) desde a Onda 4 —
> ver [google-escrita.md](google-escrita.md).

## Mudança de plano

O primeiro teste real de escrita deixou de ser pausar uma campanha vigente com
o gestor de tráfego presente ([primeira-escrita.md](primeira-escrita.md)). Não
haverá essa sessão e **nenhuma campanha vigente será tocada**. O primeiro teste
passa a ser uma **campanha de sacrifício** criada pelo próprio sistema: nasce
pausada, com verba mínima, nunca entrega e é apagada depois.

## O que "Lançar campanha" faz

1. O studio valida o formulário (`campaignDraftSchema`, no pacote shared — o
   compliance de copy roda no navegador **e** no servidor).
2. `POST /ads/campaign-requests` (permissão `ads.request`: Marketing, Admin
   Master, Diretoria) chama `reserveCampaignCreation`: mesma trava de
   emergência, mesmo período travado e mesmos três tetos do `reserveChange`.
   Grava o rascunho (`ad_campaign_drafts`, imutável) e o pedido
   (`ad_change_requests`, `kind = create_campaign`, `campaign_id` nulo).
3. `gateChange` cria a aprovação. Só `ads.approve` decide.
4. Nada mais acontece. A rota não tem cliente de plataforma: não há caminho do
   botão até a Meta.

Executar continua sendo o botão da tela de aprovação, por uma pessoa, com
`ADS_WRITES_ENABLED` ligada. O bloqueador de automação do `CLAUDE.md` segue
valendo: o pedido é sempre de uma pessoa (`requested_by_agent = false`), sem
aprovação automática e sem worker.

## O que é escrito na Meta

**Um POST**, `act_…/campaigns`: `name`, `objective`, `status`,
`special_ad_categories=[]`, `daily_budget` (centavos inteiros),
`bid_strategy=LOWEST_COST_WITHOUT_CAP`. Só a casca: **nenhum conjunto de
anúncios, criativo ou anúncio é criado** — a interface `AdsPlatformClient` nem
consegue expressar isso. Uma campanha sem conjunto de anúncios não entrega,
qualquer que seja o status; pausada, tem duas travas.

`status` nunca tem padrão: vem do rascunho aprovado (`startPaused`).

Verba: nasce pausada → reserva **zero**, como toda campanha pausada; ativar
depois é um `resume_campaign`, com reserva e aprovação próprias. Nasce ativa →
reserva `verba × dias dentro deste mês × 1,25`.

## Antes de escrever, o executor ainda confere

Além das sete garantias de sempre (aprovação, trava, teto, conta certa,
reconciliação fresca…): o rascunho guardado ainda bate com o hash aprovado, e
**não existe na plataforma campanha com o mesmo nome**. O guard também recusa
nome repetido no pedido. Motivo: um create que dá timeout não devolve id, então
`ops-cli resolve-unknown` procura a campanha **pelo nome**.

## Não verificado — o teste de sacrifício responde

- [ ] A Meta aceita `daily_budget` no nível da campanha sem nenhum conjunto de
      anúncios? Se recusar, a casca passa a nascer sem verba (ABO) e a verba
      vai para o conjunto, na onda seguinte.
- [ ] Qual o orçamento diário mínimo real da conta? O sistema só barra abaixo
      de R$ 1,00; a Meta recusa com `1487079` se for pouco, e a reserva volta.
- [ ] O token de escrita cria campanhas nesta conta (`ads_management`)?
- [ ] A conta tem restrição ativa (código 2643145 no spike 6.0). Ela impede
      criar campanha?

## Criativos e pré-visualização

- As imagens sobem para o **nosso** banco (`ad_creative_uploads`, `bytea`,
  PNG/JPEG até 8 MB, lado menor ≥ 600 px). Tipo e dimensões são lidos dos
  bytes no servidor; o que o navegador diz é ignorado. São imutáveis, e o hash
  da aprovação cobre os ids — a imagem que o aprovador viu não vira outra.
  **Nenhuma imagem vai para a Meta**: subir imagem (`adimages`) é uma escrita
  que não existe no adapter.
- A prévia na tela é **nossa**, aproximada, e diz isso. **A prévia oficial da
  Meta não foi validada** — o spike 6.0 não tratou dela. Ela exige o ID da
  página do Facebook e a imagem por URL pública ou já dentro da Meta.
- [ ] Rodar `spike-preview.ts` (somente leitura, só GETs) com o token em mãos:
      `pnpm --filter @wings/api exec tsx src/modules/ads/spike-preview.ts
<id-da-página> <url-https-pública-de-uma-imagem>`. Responde se
      `generatepreviews` aceita criativo inline, imagem por URL e o token de
      leitura. Anotar aqui o resultado antes de construir a integração.

## Cliente ideal e área de alcance

Modelo mínimo: `marketing_audience_profiles`, **uma linha por tenant** (texto
do cliente ideal + `reach` em JSON com UFs inteiras e cidades digitadas). O
builder começa do padrão salvo; cada pedido guarda a **sua cópia** no rascunho,
então editar o padrão depois não reescreve um pedido já aprovado. Salvar o
padrão exige `ads.request` e fica na auditoria.

**Raio no mapa** (onda 3b): além de estados e cidades, o operador clica num
ponto e ajusta um raio. Entra no rascunho como `reach.customLocations`
(`latitude`, `longitude`, `radiusKm` inteiro de 1 a 80, `label` opcional, até 5
pontos) — o formato de `geo_locations.custom_locations` da Meta. Os limites de
raio são os documentados pela Meta, **não verificados na conta**. O mapa é
Leaflet sobre tiles do OpenStreetMap, sem chave e sem custo. Saem do navegador
para o OpenStreetMap os tiles da área na tela e uma consulta (Nominatim) das
coordenadas clicadas, só para dar ao ponto um nome legível; nada sobre a
campanha vai junto, e se a consulta falhar o ponto fica "Ponto N". Alcances e
rascunhos gravados antes do mapa não têm o campo: a API preenche `[]` ao
devolver, sem tocar no payload guardado (o hash da aprovação é sobre ele).

Cidades são nomes digitados, não ids de uma base: hoje só uma pessoa lê isso.
**Nada de público ou localização chega à Meta nesta onda** — segmentação mora
no conjunto de anúncios, que o adapter não cria. Mapear cidade → chave de
localização da Meta pertence a essa etapa futura.

## O que falta para o sacrifício fechar

**Apagar a campanha não existe no sistema.** Não há `delete_campaign` no
adapter. Depois do teste, apaga-se à mão no Gerenciador de Anúncios, ou isso
vira a próxima escrita a construir — decisão em aberto.

## Lacuna conhecida que continua aberta

Uma campanha criada **ativa** reserva exposição que a reconciliação seguinte
apaga, porque reservas e reconciliação não se conhecem (ver "Bloqueador de
automação" em [travas.md](travas.md)). Aceitável com uma pessoa por vez; a
campanha de sacrifício nasce pausada e não passa por aí.
