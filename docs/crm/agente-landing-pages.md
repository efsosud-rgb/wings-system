# CRM Vendas — Fase 12: Agente de landing pages (especificação)

30/09/2026. **Só especificação: nada construído.** Pedido do Eric (lista de
correções, itens 8 e 9). Complementa o [benchmark e ordem das fases](benchmark-2026-09-30.md)
e usa o que a Fase 1 já deixou pronto: regras de origem por página
(CRM Vendas → Landing pages), a pasta de cada cliente no Drive
(`Clientes/<NN. Nome>`, arquivos no R2) e a rota de formulário do site
(Fase 1, T5: grava o lead e reenvia a conversão ao RD Marketing).

## 1. O que o agente faz

Um agente de IA lê a pasta da marca no Drive e **monta uma proposta** de
landing page de Expansão, com o formulário já ligado ao CRM. **O Eric aprova
antes de publicar.** Regra da casa, igual à do agente de tráfego: o agente lê e
propõe; publicar é o clique de uma pessoa, que fica na auditoria.

Entrada:

- a pasta `Clientes/<NN. Nome>` (manual da marca, logos, fotos, vídeos, Circular
  de Oferta de Franquia, apresentações, planilhas de modelos de unidade);
- a ficha do cliente (nome, relação com a Wings, perfil de franquia);
- a estrutura padrão (§2) e as regras de conteúdo (§3).

Saída: um **rascunho de página** (conteúdo por seção + referências aos arquivos
do Drive por id, `wings-drive://<id>`, nunca endereço de armazenamento), com uma
**lista de pendências** (o que ficou em branco por falta de fonte) e uma
**checagem de repetição** entre seções.

## 2. Estrutura padrão (referência: franquia.wingscompany.com.br/cenoritas)

| # | Seção | Conteúdo |
| --- | --- | --- |
| 1 | Faixa "Seja um franqueado" | chamada curta, cor da marca |
| 2 | Abertura | logo, foto principal, frase, botão para o formulário |
| 3 | História | origem da marca, fundadores, números da marca **com fonte** |
| 4 | Diferenciais | o que a marca diz de si no manual/apresentação |
| 5 | Suporte ao franqueado | treinamento, implantação, marketing, o que a marca oferece |
| 6 | Modelos de franquia | um cartão por modelo: investimento, taxa, royalties, área, faturamento/retorno — **só da COF ou documento da marca, com a fonte** |
| 7 | Formulário | nome, telefone, e-mail, valor disponível para investir, observações, anti-robô |
| 8 | Rodapé | marca, CNPJ da franqueadora quando houver na ficha, política de privacidade |

As seções se adaptam ao que a marca tem: sem material de suporte, a seção 5 não
entra (ou fica como pendência), em vez de texto genérico.

## 3. Regras de conteúdo (não negociáveis)

1. **Tudo da própria marca**: textos, artes, cores, fontes, valores e
   características vêm do manual e dos arquivos do Drive da marca. Nada de texto
   de outra marca nem de banco de imagens.
2. **Números dos modelos só da Circular de Oferta ou de documento da marca**, com
   a fonte (arquivo e página) guardada em cada número. **Sem fonte, fica em
   branco** e entra na lista de pendências para uma pessoa preencher.
3. Nada inventado: sem depoimento, prêmio, número de unidades ou prazo de
   retorno que não esteja num arquivo da marca.
4. **Checagem de repetição**: frases ou parágrafos repetidos entre seções são
   apontados antes da aprovação.
5. O nome da marca nunca vai a fornecedor de IA de imagem (regra da casa do
   Studio); o texto é gerado pelo modelo de linguagem com teto de custo diário.
6. A página nasce **não publicada**; publicar e despublicar são cliques de
   pessoa, auditados.

## 4. Formulário ligado ao CRM

- Envia para a rota pública de formulário (Fase 1, T5) com token por página,
  honeypot, limite por IP e anti-robô (Cloudflare Turnstile ou o captcha que o
  Eric preferir): cria o lead (fonte `site_form`, regra da página → marca e
  funil Expansão) **e reenvia a conversão ao RD Marketing** com o mesmo
  identificador, para os fluxos do RD continuarem enquanto o RD for oficial.
- Campos ocultos de atribuição (UTMs, `gclid`, `fbclid`, referrer) gravados no
  lead (colunas da Fase 1).
- "Valor disponível para investir" usa as faixas unificadas do CRM (spec §3.4).
- Pixel/GTM da Wings na página, com o evento de conversão (sem dado pessoal).

## 5. Medição

A página própria resolve o "—" de visitas do sub-módulo Landing pages: contagem
de visitas e envios por página no nosso servidor (sem cookie de terceiros, sem
dado pessoal), mostrada como fonte "servidor da Wings". Referência de conversão
informada pelo Eric (fonte: painel do RD): **Casal do Churros NOVA, 12% em
setembro; média das páginas, 4%.** Meta de cada página nova: comparar com a
média do RD no mesmo mês, com a fonte de cada número.

## 6. Telas

- CRM Vendas → Landing pages ganha "Nova página com o agente": escolher o
  cliente, o agente lê a pasta e devolve o rascunho em minutos.
- Editor por seção (texto, imagem do Drive, cor), pré-visualização em celular e
  computador, lista de pendências e de repetições, botão **Enviar para
  aprovação**; aprovação do Eric (ou de quem tiver a permissão nova
  `landing_pages.publish`) com **Publicar**.
- Versões: cada publicação guarda a versão; voltar é publicar a anterior.

## 7. Domínio e virada (item 9)

Hoje (lido em 30/09): `franquia.wingscompany.com.br` é **CNAME para
`pages.rdstation.com.br`** — as 135 páginas (número do Eric, painel do RD) são
servidas pelo RD. O sistema responde em outro servidor.

**Durante a convivência** — páginas novas num endereço nosso, sem tocar no do RD:

- `lp.wingscompany.com.br/<slug>` (proposta; alternativa
  `franquias.wingscompany.com.br`), CNAME/A para o servidor da Wings, rota no
  Traefik para o serviço de páginas, certificado Let's Encrypt emitido antes de
  anunciar. Nenhuma página do RD muda.
- As regras de origem já aceitam host + slug, então a página nova entra no
  sub-módulo Landing pages com o endereço novo.
- Campanhas novas apontam para o endereço novo; as antigas continuam no RD.

**Virada do `franquia.wingscompany.com.br`** (só quando o Eric decidir, página
por página, sem derrubar nenhuma):

1. Inventário das 135 páginas do RD (a API do RD não lista páginas: exportar do
   painel ou montar pela lista de identificadores de conversão), com a decisão
   por página: migrar, redirecionar para outra, ou arquivar.
2. Toda página que continuar no ar precisa existir antes no endereço novo (ou
   ter um redirecionamento 301 definido).
3. Baixar o TTL do registro para 5 min, 48 h antes.
4. Emitir o certificado de `franquia.wingscompany.com.br` no nosso servidor
   (desafio DNS, para não depender da troca).
5. Trocar o registro para o nosso servidor; o servidor responde as páginas que
   tem e faz **301 para o endereço novo** das migradas; slug desconhecido vai
   para uma página "marcas" (nunca 404 em link de anúncio).
6. Conferir as 135 URLs com um robô (status e formulário) logo depois; qualquer
   falha: voltar o CNAME para o RD (TTL curto = volta em minutos).
7. Manter o domínio do RD como reserva até o fim da convivência do RD Marketing.

A confirmar no RD antes da virada: se as páginas continuam acessíveis por outro
domínio personalizado do RD (para um eventual proxy de reserva).

## 8. Estimativa e dependências

| Parte | Dias |
| --- | ---: |
| Leitura da pasta do Drive e extração de manual/COF (com fonte por número) | 3 |
| Montagem do rascunho por seção + checagem de repetição + pendências | 3 |
| Editor, pré-visualização, aprovação, versões | 3 |
| Serviço de páginas, domínio novo, formulário (reuso da T5), medição | 3 |
| **Total** | **12** |

Depende de: Fase 1 T5 (rota de formulário), pastas do Drive com o material da
marca, decisão do domínio (§7), teto de custo de modelo por dia, anti-robô
escolhido. A virada do `franquia.` é decisão separada do Eric.
