# Decisões de arquitetura e de forma de trabalho

Um arquivo por decisão do Eric (ou aprovada por ele) sobre como o sistema é construído, onde roda e como pessoas e
agentes trabalham nele. Todo agente lê este índice e os registros que tocam a tarefa antes de começar, junto com o
caderno de lições [`../licoes.md`](../licoes.md). A revisão de arquitetura compara o código com estes registros.

Regras de negócio (quem pode o quê, prazos, travas de um módulo) continuam em [`../decisoes.md`](../decisoes.md), uma
por linha; as regras que o código precisa garantir, com o teste, estão em [`../invariantes.md`](../invariantes.md).

## Índice

| Nº                                                    | Decisão                                                                         | Data       | Situação |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- | ---------- | -------- |
| [0001](0001-typescript-react-fastify.md)              | TypeScript em tudo, React (Vite) na tela e Fastify na API, num monorepo pnpm    | 16/09/2026 | em vigor |
| [0002](0002-postgresql-proprio.md)                    | PostgreSQL próprio em cada ambiente, com migrations do Drizzle                  | 16/09/2026 | em vigor |
| [0003](0003-coolify-no-servidor-da-wings.md)          | Coolify no servidor da Wings, sem Kubernetes                                    | 16/09/2026 | em vigor |
| [0004](0004-mesma-origem-e-sessao-no-servidor.md)     | Mesma origem em todo ambiente e sessão guardada no servidor, sem JWT            | 16/09/2026 | em vigor |
| [0005](0005-autorizacao-so-na-api.md)                 | Permissão e escopo dos dados são decididos só na API                            | 16/09/2026 | em vigor |
| [0006](0006-whatsapp-pela-api-oficial.md)             | WhatsApp pela API oficial da Meta, sem ferramenta intermediária                 | 30/09/2026 | em vigor |
| [0007](0007-numeros-do-whatsapp.md)                   | Números das vendedoras em coexistência; número próprio, só da API, para a Sofia | 30/10/2026 | em vigor |
| [0008](0008-plataformas-so-pela-via-oficial.md)       | Instagram, Google e TikTok só pela via oficial de cada plataforma               | 29/10/2026 | em vigor |
| [0009](0009-producao-so-com-o-eric.md)                | Produção só com o Eric, que digita PRODUCAO                                     | 29/10/2026 | em vigor |
| [0010](0010-revisao-independente.md)                  | Revisão independente antes de juntar                                            | 27/10/2026 | em vigor |
| [0011](0011-portao-de-qualidade.md)                   | Portão de qualidade em todo PR, numa CI que roda no servidor da Wings           | 27/10/2026 | em vigor |
| [0012](0012-dinheiro-e-mensagem-nascem-desligados.md) | O que gasta dinheiro ou manda mensagem nasce desligado                          | 30/10/2026 | em vigor |
| [0013](0013-anuncios-e-verba-so-com-o-eric.md)        | Anúncio e verba só por ordem do Eric, sem automação de gasto                    | 09/10/2026 | em vigor |
| [0014](0014-segredos-so-no-coolify.md)                | Segredos só nas variáveis do Coolify, e quem cola é o Eric                      | 16/09/2026 | em vigor |
| [0015](0015-agentes-autonomos-sob-a-politica.md)      | Agentes autônomos trabalham sob a política de 29/10                             | 29/10/2026 | em vigor |
| [0016](0016-memoria-do-projeto.md)                    | Decisões e lições ficam no repositório, e todo agente lê antes de trabalhar     | 30/10/2026 | em vigor |

A data é a da decisão mais antiga do registro; as datas seguintes estão dentro de cada arquivo.

## Como registrar uma decisão nova

1. Só entra decisão que o Eric tomou ou aprovou, de arquitetura ou de forma de trabalho. Proposta de agente vai para o
   relatório ou para [`../ideias.md`](../ideias.md); regra de negócio vai para [`../decisoes.md`](../decisoes.md).
2. Copie [`modelo.md`](modelo.md) para `NNNN-assunto-curto.md`, com o próximo número, e preencha todos os campos. Sem
   fonte escrita, a decisão não entra. Motivo ou autor que a fonte não diz ficam como "não registrado".
3. Acrescente a linha no índice acima.
4. Decisão que substitui outra: não apague a antiga. Na antiga, troque a situação para "substituída por [NNNN] em
   dd/mm/aaaa"; na nova, diga qual ela substitui.
5. Nada de telefone, e-mail ou nome de lead, cliente ou funcionário nos registros: cite por id ou pelo papel.
6. O registro entra por PR, como qualquer mudança.
