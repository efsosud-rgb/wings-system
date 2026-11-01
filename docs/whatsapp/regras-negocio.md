# Regras de negócio — WhatsApp e Sofia

Versão de 04/10/2026. "Decidido" veio do Eric. "Proposta" é sugestão para ele aprovar; não implementar proposta como regra definitiva sem o OK.

## 1. Quem é a Sofia (decidido)

- Atendente virtual da Wings. Na primeira mensagem diz isso com todas as letras.
- Pré-qualifica e transfere. Não negocia, não fecha, não substitui o vendedor.
- Faz o acompanhamento (follow-up) da conversa depois que o lead entra no CRM.
- Prioridade máxima da Wings: leads qualificados de **Formatação** (empresas que querem franquear ou crescer, franqueando ou não).
- Não pedir campos que travam o lead (CNPJ, site e afins). Enriquecimento do perfil fica para uma IA depois, com dados públicos.

## 2. Limites da Sofia (proposta)

- Não informa valores de investimento, taxas ou retorno de nenhuma franquia: isso é da COF e do vendedor.
- Não promete resultado, prazo ou aprovação.
- Transfere na hora para um humano quando: o lead pede uma pessoa; é reclamação; é cliente ou franqueado atual; é assunto jurídico ou financeiro específico; não entendeu a mensagem duas vezes; chegou áudio e ainda não há transcrição.
- Mensagens curtas (até 3 linhas), tom cordial, sem gíria, sem emoji em excesso.

## 3. De onde o lead veio

| Entrada                                                  | Como identificar                                                 | Exemplo                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| Botão do site                                            | Texto pronto no link `wa.me/<número>?text=` com um código no fim | `Olá! Quero avaliar meu negócio. [W-SITE-HOME]` |
| LP de marca cliente (franquia.wingscompany.com.br/marca) | Código com a marca                                               | `[W-LP-CASALDOCHURROS]`                         |
| Anúncio de clique para WhatsApp (Meta)                   | Objeto `referral` no webhook (anúncio, `source_id`, `ctwa_clid`) | gravado direto                                  |
| Contato direto, sem código                               | A Sofia pergunta "Como você conheceu a Wings?"                   | —                                               |

Decidido (30/09): o lead precisa responder "por onde conheceu a Wings" e "por meio de qual campanha ativa", com as campanhas ativas como opções. Na fase 1 a lista é fixa no Flow; na fase 2 vem do CRM.

## 4. Segmentos e Flows

1. A Sofia identifica o interesse pelo código de entrada; sem código, pergunta: "Você quer transformar seu negócio em franquia, abrir uma franquia de uma marca, ou crescer seu negócio sem franquear?"
2. Envia o Flow do segmento:
   - **Expansão** (abrir uma franquia de marca cliente): `flow-expansao.json`. A marca de interesse vai pré-preenchida quando vier do código.
   - **Formatação** (franquear o próprio negócio) e **Consultoria** (crescer sem franquear): `flow-formatacao.json`.
3. Se o lead não abrir o Flow, a Sofia faz as mesmas perguntas em texto, uma por vez.

## 5. Resultado da pré-qualificação

- **Expansão qualificado (decidido):** entra no funil Expansão do CRM como "Novo Contato".
- **Expansão não qualificado (decidido):** entra no CRM como "Perda marcada", com motivo.
- **Formatação e Consultoria:** funil e etapa de entrada a definir (pergunta 2).
- **Critério até as regras finais (proposta):** a Sofia não marca perda por perfil sozinha. Todo lead que responde ao Flow vai para o vendedor, com a ficha preenchida. Perda automática só em casos objetivos: pediu para não ser contatado, número errado ou spam, procura emprego ou é fornecedor.

Motivos de perda (proposta, tabela `dim_motivo_perda` do BI): pediu para não ser contatado · contato errado ou spam · procura emprego ou é fornecedor · fora do perfil da marca · sem resposta após acompanhamento (fase 2).

## 6. Distribuição (decidido)

- Sorteio entre os vendedores ativos do setor (Expansão ou Formatação).
- Cada vendedor só vê os próprios leads; o gestor do setor vê todos do setor.
- A conversa inteira fica gravada no lead; o vendedor responde de dentro do CRM.

## 7. Janela de 24 h e modelos

- Dentro de 24 h da última mensagem do lead: resposta livre (sem custo de modelo na Meta).
- Fora disso: só modelo aprovado (lembrete, retomada de contato). Cada modelo enviado é cobrado pela Meta por mensagem, conforme a categoria.
- "SAIR" ou "PARAR": a Sofia confirma (uma vez só) e o contato fica bloqueado para mensagens ativas. Depois disso a conversa fica bloqueada para a Sofia: quem escrever de novo, outro SAIR incluído, cai em "Aguardando atendente" e uma pessoa decide. A equipe também não envia nada (texto, arquivo, áudio, modelo), por nenhum número, nem dentro das 24 h e nem depois que a pessoa escreve de novo, até a gerência revogar o bloqueio na negociação, com motivo (Eric, 30/10 e 31/10).
- A frase escrita pela IA só chega ao lead se for uma das frases de reconhecimento aprovadas (Eric, 29/10, WA-04; lista em `sofia.md`).

## 8. Transição com o RD Station

Decidido em 28/09: todo lead de expansão precisa entrar no RD CRM, funil Expansão. Decidido em 30/09: o RD roda em paralelo até a troca. Se a fase 1 for para produção antes do CRM Vendas, o lead também precisa chegar ao RD (pergunta 6).

## Perguntas em aberto (para o Eric)

1. Critérios de qualificação de cada segmento (ex.: investimento mínimo de cada marca, que vem da COF).
2. Funil e etapa de entrada dos leads de Formatação e de Consultoria.
3. Horário de atendimento humano e o que a Sofia diz fora dele.
4. Caminho do número comercial na Cloud API (coexistência com o app, número novo ou migração total; ver `integracoes.md`).
5. OK para a homologação usar o número de teste da Meta (exceção à regra de 19/09).
6. Enquanto o CRM Vendas não estiver em produção, o lead também vai para o RD?
7. Lista de campanhas ativas para a pergunta de origem e quem a mantém.
8. Faixas de investimento de cada marca (as do Flow são só ponto de partida).
9. Link da política de privacidade a usar no Flow (o site tem "Política & Cookies").
