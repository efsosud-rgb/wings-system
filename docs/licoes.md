# Caderno de lições da Wings (cada erro vira regra)

> Cópia de `/opt/agentes/modelos/licoes.md`, o caderno mestre onde o Zeus junta as lições novas. Mudou o mestre, mude esta cópia por PR no mesmo dia ([decisão 0016](decisoes/0016-memoria-do-projeto.md)).

Leia antes de começar qualquer tarefa. Cada item veio de um erro real. Um erro que já está aqui e reaparece num PR é **bloqueio** na revisão.
Achou um erro novo? Corrija, escreva um teste que o pegue e registre a lição (o agente da fila em `LICOES.md` na pasta da execução; o Zeus junta aqui).

## Código

1. **Resposta do Fastify não sai de função `async` auxiliar** (30/10, PR #66). `reply.status(...).send(...)` é "thenable": devolvida de uma função `async` e esperada com `await`, vira `undefined`, o `if (limited) return limited;` não retorna e o código segue (um pedido recusado com 429 ia para a Meta depois da resposta). Regra: a função auxiliar devolve o motivo (texto ou `null`); quem chama envia a resposta e dá `return` na hora.
2. **Teste não depende do dia de hoje** (30/10, PR #64/#65). Um teste com "último dia do mês" quebrou em 30/10. Regra: relógio fixo injetado (`now`) ou datas relativas a um dia fixo; nada de `new Date()` solto em asserção de calendário.
3. **"Não me contate" vale por todas as chaves** (30/10, revisão do #64). Conferir só o endereço escolhido deixava passar um contato bloqueado pelo telefone. Regra: antes de qualquer saída, confira todas as chaves do contato e do lead (e-mail e telefone).
4. **Recusa encerra a ação** (30/10). Toda trava (limite, "não me contate", janela de 24 h, permissão) responde e termina; nenhum envio, gravação ou chamada externa acontece depois da recusa. Teste: depois da recusa, espere um pouco e confira que nada chegou ao simulador.
5. **Contagem e gravação juntas** (30/10, revisão do #66). Conferir um limite e gravar em passos separados deixa dois cliques passarem juntos. Regra: limite que importa fica na mesma transação, com trava por chave (trava consultiva do Postgres) ou restrição no banco.

## Portão e testes

6. **Teste com banco antes do PR, sempre** (30/10, piloto do Orca). Um PR passou sem os testes com banco e os 2 testes novos falharam no CI com um erro real. Regra: rode os testes da API com o banco de teste (`DATABASE_URL`); "rodou só sem banco" não é portão verde.
7. **Teste novo prova alguma coisa** (revisões de 29 e 30/10). Para cada teste novo de regra de negócio, quebre a linha principal, veja o teste falhar e restaure; registre no relatório.

## Plataformas

8. **WhatsApp em coexistência não liga pela API** (30/10). Número que está no app e na API ao mesmo tempo não usa a API de chamadas; a ligação pelo sistema só sai pelo número que está só na API (o número da Sofia).
9. **Google Ads, conversões offline** (13/10, `docs/ads/fechar-ciclo.md`). Desde 15/06/2026 o `UploadClickConversions` falha para developer token que nunca enviou conversões; o caminho é a Data Manager API.
10. **Meta Embedded Signup** (30/10). As versões 2 e 3 deixaram de valer em 15/10/2026; use a v4.

## Ferramentas

11. `gh pr edit` falha por causa do "Projects (classic)": mude a descrição com `gh api -X PATCH repos/<dono>/<repo>/pulls/<n> -F body=@arquivo`.
12. `gh pr checks` não tem `--json`, e `gh run view` sem id abre um seletor interativo: use `gh run list --branch <ramo> --json databaseId,status,conclusion`.
13. Rodar de novo um job que falhou usa o mesmo commit de merge; para testar o PR com a develop nova, feche e reabra o PR (ou envie um commit).
