# Importar conversa do celular

Ordem do Eric de 19/10/2026, desenho na seção 10 de
`/root/relatorios/whatsapp-oficial/coexistencia-2026-10-14.md`. Antes de o 0288 sair do app WhatsApp Business e ir só
para a Cloud API (caminho C), as conversas que importam são exportadas no celular e trazidas para a negociação. Só
conversas ligadas a leads do CRM; a lista sai do cruzamento dos chats da Z-API com os leads. Migração **0093**.

## Como se usa

1. **No celular**
   - **Android:** abrir a conversa e tocar em ⋮ › Mais › **Exportar conversa**.
   - **iPhone:** abrir a conversa, tocar no nome do contato › **Exportar conversa**.
   - Escolher **com mídia**, que gera um `.zip`, ou **sem mídia**, que gera só o `.txt`, e mandar o arquivo para o
     computador.
2. **No sistema**
   - Abrir a negociação › WhatsApp › **Importar do celular** e escolher o `.txt` ou o `.zip`.
   - A prévia mostra:
     - o tipo de celular;
     - quantas mensagens o arquivo tem e quantas já estão na conversa;
     - quantas linhas são mídia;
     - os avisos do próprio app, que ficam de fora;
     - a primeira e a última mensagem.
   - Também pergunta **qual nome é a Wings**. Já vem marcado o único nome com "Wings", quando há só um.
3. **Importar**
   - O arquivo exportado é guardado em Arquivos da negociação, pelo envio de sempre (endereço assinado, tipo e tamanho
     exatos). O nome ganha a data da importação, para caber uma segunda exportação da mesma conversa.
   - Depois disso, as mensagens são gravadas.
4. **Desfazer importação**
   - Fica na mesma janela e apaga só as mensagens daquela importação.
   - O arquivo continua em Arquivos.

Ninguém recebe nada:

- não sai mensagem;
- a Sofia não responde;
- não nasce aviso nem tarefa;
- a janela de 24 h fica como estava, porque `wa_contacts.last_inbound_at` não é tocado.

## Regras

- **O vínculo é a negociação aberta na tela.** O arquivo não traz o telefone quando o contato estava salvo, então não
  há casamento automático por nome. A negociação precisa ter telefone, que dá o contato e a conversa
  (`wa_conversations`, uma por telefone e negociação).
- **Formato lido** (`modules/whatsapp/import-parse.ts`)
  - **Linhas:**
    - Android: `DD/MM/AAAA HH:MM - Nome: texto`.
    - iPhone: `[DD/MM/AAAA HH:MM:SS] Nome: texto`.
    - O ano pode vir com 2 dígitos.
  - **Continuação:** uma linha sem data continua a mensagem de cima.
  - **Avisos do app:** uma linha datada sem "Nome: " é aviso do próprio app (criptografia, alguém entrou) e fica de
    fora.
  - **Mídia:**
    - `IMG-….jpg (arquivo anexado)` e `<anexado: …>` viram balão do tipo do arquivo, com o nome do arquivo.
    - `<Mídia oculta>` e `imagem ocultada` dizem que a mídia não veio.
  - **Hora:** é a do celular, lida como UTC-3. Brasília não tem horário de verão desde 2019; uma conversa anterior a
    isso pode ficar uma hora fora no verão.
- **Mídia:** fica dentro do arquivo exportado, em Arquivos. O balão diz o nome do arquivo e que ele está lá. Nada é
  extraído do `.zip` no servidor: o navegador tira dele só o `.txt` (`exportTextOf`, com `fflate`), e o servidor lê de
  novo o texto.
- **Sem duplicar**
  - Cada linha leva um SHA-256 de hora, autor, tipo, arquivo, texto e quantas iguais vieram antes
    (`wa_messages.import_hash`), único por negociação.
  - Reimportar o mesmo arquivo, ou uma exportação mais nova que contém a antiga, grava só o que falta.
  - Se nada for novo, a resposta é 409 `nothing_new`.
- **Ordem**
  - `created_at` recebe a hora do arquivo, com 1 ms a mais por mensagem do mesmo minuto, para manter a ordem do
    arquivo. A conversa é ordenada por esse campo.
  - A tela mostra as 500 últimas, e "Mostrar mensagens anteriores" carrega as de antes, 500 por vez.
- **Lado de cada linha**
  - O nome escolhido como Wings vira `direction = 'out'` e `author = 'app'`, sem status nosso.
  - O outro lado vira `in` e `contact`.
- **Conversa nova nasce encerrada:** quando a negociação ainda não tinha conversa, a importação abre uma com
  atendimento `closed`. Assim a próxima mensagem real da pessoa segue a regra de conversa nova: vai ao vendedor
  (`waiting_seller`) ou, sem dono, à Sofia. Uma conversa que já existia não muda de estado.
- **Fora das contas e da Sofia**
  - A contagem de não lidas da lista ignora linhas importadas.
  - A rodada da Sofia ignora linhas importadas (`import_batch_id is null`).
  - Triagem (Jev) e criação de negociação pela Sofia só leem conversas sem negociação, e a importação nunca grava
    numa delas.

## Acesso

- `leads.whatsapp` pela regra única `leadInScope`, como a conversa: o vendedor só nas negociações dele. Fora do
  alcance, a resposta é 404.
- O botão também pede `leads.write`, porque guarda o arquivo em Arquivos.

## Rotas

| Rota                                           | O quê                                                  |
| ---------------------------------------------- | ------------------------------------------------------ |
| `POST /leads/:id/whatsapp/imports/preview`     | `{ text }` → prévia; não grava nada                    |
| `POST /leads/:id/whatsapp/imports`             | `{ text, ourName, fileId }` → grava um lote (201)      |
| `GET /leads/:id/whatsapp/imports`              | Importações da negociação, a mais nova primeiro        |
| `DELETE /leads/:id/whatsapp/imports/:batchId`  | Desfaz o lote; 409 `already_undone` se já foi desfeito |
| `GET /leads/:id/whatsapp/messages?before=<id>` | As 500 mensagens anteriores a uma que está na tela     |

Erros:

| Código | Erro                 | Quando                                      |
| ------ | -------------------- | ------------------------------------------- |
| 422    | `not_an_export`      | O texto não parece uma conversa exportada   |
| 400    | `unknown_side`       | O nome escolhido não está no arquivo        |
| 409    | `lead_without_phone` | A negociação não tem telefone               |
| 404    | `file_not_found`     | O arquivo não é um dos anexos da negociação |

O corpo aceita até 10 milhões de caracteres (`WA_IMPORT_MAX_CHARS`).

## Registro

- **Histórico da ficha:** uma linha por importação ("Conversa do celular importada", com o total e o período) e uma
  quando ela é desfeita, filtro "WhatsApp". As mensagens em si ficam na tela WhatsApp da negociação.
- **Auditoria** (`whatsapp.conversation_imported`, `whatsapp.import_undone`): só ids, contagens, datas e o tipo de
  celular, nunca nome ou texto.
- **Banco**
  - `wa_import_batches`: uma linha por importação, com o arquivo, as contagens, o período, quem importou e quem
    desfez.
  - O `wings_ro` lê a visão `wa_imports_analysis`, com ids, contagens por direção e datas, e não lê a tabela de
    mensagens.

## Não verificado

- **Exportações reais:** os formatos acima são os conhecidos da FAQ do WhatsApp e nenhum foi conferido com um
  arquivo real do 0288. Os testes usam conversas inventadas. Antes da carga, importar uma conversa de teste e
  conferir na tela.
- **Limites da FAQ:** com mídia, as 10.000 mensagens mais recentes; sem mídia, 40.000.
- **Arquivos grandes:** um `.zip` com muita mídia é aberto inteiro na memória do navegador.
