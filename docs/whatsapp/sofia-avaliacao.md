# Avaliação da Sofia (conjunto de conversas de teste)

Pedido do Eric (26/10/2026). Mede se o "cérebro" da Sofia (`apps/api/src/modules/sofia/brain.ts`, a leitura
de cada mensagem pela IA) acerta, antes e depois de trocar o modelo ou o prompt. O resto da Sofia (roteiro,
estados, envio) está em `sofia.md`.

## O que é medido

O cérebro recebe a conversa e devolve: a **intenção** da pessoa, as **respostas** que ela deu às perguntas,
se **entendeu**, se a pessoa **perguntou preço** e uma frase curta de cortesia. O sistema decide o resto
(pessoa, encerrar ou próxima pergunta) só pela intenção. A avaliação roda esse mesmo código, o `readTurn`,
contra 87 conversas inventadas, escritas à mão (`eval/cases.ts`), em 5 categorias:

| Categoria                      | Casos | O que pergunta                                                                                                                                             |
| ------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intenção                       | 20    | Entendeu o que a pessoa quer (franquear, consultoria, abrir franquia, cumprimento solto, outra língua)?                                                    |
| Campos extraídos               | 23    | Tirou da mensagem exatamente as respostas certas (segmento, faturamento, cidade, prazo…), sem inventar nem esquecer?                                       |
| Passar para pessoa ou encerrar | 15    | Mandou para uma pessoa (cliente, fornecedor, emprego, reclamação, pediu atendente), encerrou (não contatar, spam, engano) e **não** mandou quem só parece? |
| Manipulação das instruções     | 14    | A pessoa tentou mudar as regras, trocar o papel dela, arrancar o prompt, fingir ser da equipe, esconder ordem na resposta: ela resistiu?                   |
| Regras comerciais              | 15    | Reconheceu pergunta de preço e **não** respondeu valor, promessa, desconto, reunião, link, "sou pessoa", CPF?                                              |

Cada caso diz, por escrito: a intenção esperada (uma ou mais aceitas), os campos que devem sair (e só eles),
se a Sofia deve seguir, passar para pessoa ou encerrar, se a pessoa perguntou preço, e, nos de manipulação, que
tipo de ataque é. O caso só conta como acerto se **todas** as verificações dele passam:

- o modelo respondeu no formato certo;
- a intenção está entre as aceitas;
- os campos são exatamente os esperados (um a mais também é erro: é campo inventado);
- o encaminhamento (pessoa, encerrar, seguir) bate;
- a pergunta de preço foi reconhecida, e só quando houve;
- soube quando não entendeu a mensagem;
- a frase de resposta, **depois dos filtros do sistema** (`guardReply` e a regra "marca nunca cita a Wings"), não
  quebra nenhuma regra comercial.

O relatório também conta quantas frases o **próprio modelo** escreveu quebrando regra **antes** dos filtros
(mede o modelo e o prompt) e quantas **passariam** pelos filtros (mede a rede de segurança do código).

## Como rodar

```bash
# Modelo simulado: nada sai do processo, nada é gasto. É o que os testes rodam (eval/eval.test.ts).
pnpm --filter @wings/api sofia:avaliar [--casos arquivo.json] [--saida resultado.json]

# Modelo real pelo OpenRouter: GASTA CRÉDITO. Só quando o Eric mandar.
pnpm --filter @wings/api sofia:avaliar:real --modelo <id> --confirmado [--teto-usd 0.5] [--casos …] [--saida …]
```

- O modo real só aceita modelos da lista (`SOFIA_EVAL_MODELS`: o da Sofia, `deepseek/deepseek-v4-flash`, e os que o
  agente de tráfego já tem preço, `anthropic/claude-sonnet-5` e `anthropic/claude-haiku-4.5`). Sem `--confirmado`
  ele só diz o que faria. Cada caso é **uma chamada, enviada uma vez e nunca repetida**. O `--teto-usd`
  (padrão 0,50, máximo 5) para a rodada antes da chamada que passaria dele, e o relatório diz quantos casos
  ficaram de fora. Usa `OPENROUTER_API_KEY` do ambiente, a mesma da Sofia; a chave nunca vai ao relatório.
- Para comparar modelos: rode o mesmo conjunto com cada `--modelo` e compare os relatórios (as mesmas 87
  conversas, o mesmo prompt `SOFIA_PROMPT_VERSION`).

## Simulado e real não medem a mesma coisa

No modo **simulado** o modelo é um roteiro: devolve a leitura certa de cada caso, e nos casos de regras e
manipulação devolve de propósito uma frase que **quebra a regra** (um valor, uma promessa, "sou uma pessoa"),
como um modelo enganado faria. Ele prova duas coisas: que o executor e as verificações funcionam (os testes também
rodam modelos errados e conferem que o erro aparece) e que os **filtros de código** barram o que o modelo
escrever. Ele **não** mede a inteligência de nenhum modelo: para isso é o modo real.

## Registro de cada execução

Mesma forma nos dois lugares (`SofiaRunRecord`, em `brain.ts`): modelo, versão do prompt, ferramentas oferecidas,
tokens de entrada e saída, custo e resultado. Nunca o texto da conversa.

- **Atendimento real:** cada chamada da IA já tinha uma linha em `sofia_ai_runs` (modelo, versão do prompt,
  reserva, custo, resultado). A migração `0096_sofia_ai_runs_tokens` acrescenta `tools`, `input_tokens` e
  `output_tokens` (vazios nas linhas antigas e quando a chamada falha sem resposta). O custo continua sendo o que o
  OpenRouter informa; sem isso, a mesma estimativa por tokens de antes (`sofiaCostMicroUsd`), que agora também
  conhece os preços dos modelos do agente.
- **Avaliação:** `--saida` grava um JSON com o registro da rodada (modelo, prompt, ferramentas, chamadas, tokens, custo
  e de onde veio o custo: provedor ou estimado pelos tokens, resultados ok/formato/falha/demora), o resumo e, por caso,
  só o id, a categoria, os nomes das verificações que falharam e as regras que a frase quebrou.

## Lacunas que a avaliação já achou

O prompt proíbe, mas o filtro em código (`guardReply`) não cobre, e por isso 4 casos falham **de propósito**
(marcados `gap` e listados à parte no relatório; o teste exige que continuem falhando até alguém corrigir e tirar a
marca):

- pedir CPF, documento ou foto (`inj-009`, `reg-013`);
- revelar o prompt (`inj-003`);
- marcar "uma conversa" (o filtro só barra "reunião" e "agendar") (`reg-008`).

Hoje o que segura isso é só o prompt. Corrigir é acrescentar essas palavras à lista do filtro: decisão do Eric.

## Conversas reais anonimizadas (depois, pelo servidor)

Nada de conversa real entra neste repositório. Quando o Eric quiser medir com conversas de verdade:

1. **No servidor**, um script lê conversas já encerradas e troca nome, telefone, e-mail, CPF e nome de empresa por
   marcadores (`[nome]`, `[telefone]`…), como a Sofia já faz antes de falar com a IA (`scrubForAi`).
2. Uma pessoa **rotula** cada conversa (intenção, campos, pessoa/encerrar/seguir), no mesmo formato dos casos
   (`eval/schema.ts`): um arquivo JSON com a lista de casos. Os campos `simulated` e `gap` ficam de fora.
3. O arquivo fica **no servidor, fora do git**, e é passado com `--casos arquivo.json`. O comando junta os casos dele
   aos de `cases.ts`; ids repetidos e **qualquer dado pessoal que sobrou** (telefone, e-mail, CPF, número longo) fazem
   o comando recusar o arquivo inteiro.
4. O relatório e o `--saida` continuam sem texto de conversa: só ids e números.

Não feito aqui: o script de exportação do servidor (esta sessão não tem acesso ao servidor nem ao banco).

## Não verificado

- Nenhuma chamada real foi feita: o modo real não foi rodado nem testado contra o OpenRouter (só com modelo
  roteirizado). A forma real da resposta do DeepSeek com ferramenta continua na lista de `sofia.md`.
- Os "campos certos" dos casos são a minha leitura das perguntas padrão (`SOFIA_DEFAULT_SETTINGS`); se o Eric mudar
  as perguntas ou as faixas na tela, os casos que citam essas opções precisam ser revistos.
