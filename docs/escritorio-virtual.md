# Escritório virtual (Laboratório)

Protótipo em `/laboratorio/escritorio`, visível só ao Admin Master (permissão `office.read`, que só o
`admin_master` tem). A empresa como um escritório 3D isométrico low-poly, alimentado por dados reais.

## De onde vem cada coisa

| Elemento               | Dado real                                                                                                                                    | Origem                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Mesa                   | cada funcionário com `status = active`, na sala do seu setor (Formatação pai → Processos e Projetos)                                         | `employees`, `sectors`, `roles`                            |
| Boneco sentado         | sessão viva usada nos últimos 15 min; sem sessão, a cadeira fica vazia                                                                       | `sessions`                                                 |
| Monitor                | próxima tarefa aberta (por prazo) de negociação aberta; senão, a negociação aberta movida por último; senão "—" e o motivo                   | `lead_tasks`, `leads`                                      |
| Registro de atividades | lead novo, mudança de etapa, ganho, perda, tarefa concluída, troca de dono (7 dias, 40 itens)                                                | `leads`, `lead_stage_history`, `lead_tasks`, `lead_events` |
| Indicadores            | leads novos hoje, vendas ganhas hoje, tarefas concluídas hoje, atrasadas, pessoas no sistema (dia do Rio)                                    | mesmas tabelas                                             |
| Agentes                | Sofia: último movimento com `source = 'sofia'`; tráfego e edição: última resposta e propostas abertas (só horário e contagem, nunca o texto) | `lead_stage_history`, `agent_messages`, `agent_proposals`  |
| Luz                    | hora do Rio (`America/Sao_Paulo`): manhã 6–9, dia 9–17, pôr do sol 17–19, noite                                                              | relógio do servidor                                        |
| Chuva                  | não desenhada: o sistema não tem fonte de clima                                                                                              | —                                                          |

Nada sai com dado pessoal: funcionário pelo primeiro nome (inicial do sobrenome só se dois
coincidirem), negociação pelo funil e pela etapa, tarefa pelo tipo; nunca nome, contato ou título
livre do lead. Os bonecos só se mexem por evento novo do CRM (pulinho; venda ganha = levanta,
confete e selo "Venda ganha!"). Planta, sofá, café e a gata são enfeite.

## Regras da cena

- three r186, um `WebGLRenderer` no canvas da tela (o logo do menu tem o outro contexto), sem React
  Three Fiber e sem GSAP; geometria feita no código (nenhum asset de terceiro).
- Objetos repetidos em `InstancedMesh`: 16–17 draw calls e ~5 mil triângulos com 12 pessoas.
- `prefers-reduced-motion`: cena parada, sem voo de câmera nem confete; o selo da venda aparece.
- Sem WebGL2 (ou em "Ver como lista"): a mesma informação em lista por setor.
- Sair da tela libera tudo (`dispose` + `forceContextLoss`); a memória da GPU não cresce ao entrar e
  sair (conferido 3 vezes: 17 geometrias, 1 textura).

## Medidas (1 unidade = 1 m; padrões de mobiliário, estimadas, não medidas na Wings)

Mesa 1,40 × 0,70 × 0,74 (NBR 13966) · assento 0,48 a 0,46 m (NBR 13962) · monitor 24" · sofá
2,00 × 0,85 × 0,80 · mesa de reunião 2,40 × 1,10 · gata 0,45 m. Paredes com 1,1 m (corte, para ver
as mesas).

## Próximas etapas

1. Eric confere no staging com a equipe real (FPS em computador e celular de verdade).
2. Clique na tarefa abrir a própria tarefa (hoje abre a negociação, onde a tarefa está listada).
3. Sala de reunião viva: rascunhos e decisões, quando houver fonte (Roadmap, Projetos).
4. Quadro de trabalho (rascunhos, perguntas, resultados) dos agentes, a partir de `agent_proposals`.
5. Passeios de câmera e decoração; chuva só com uma fonte de clima aprovada.
6. Abrir a outros papéis só com as consultas escopadas (próprio/setor) antes.
