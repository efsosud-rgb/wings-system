# Modelos de mensagem (CRM Vendas → WhatsApp → Modelos)

Ordem do Eric (26/10/2026): os modelos de mensagem são escritos, editados e mandados para a aprovação da Meta
pelo sistema, e cada campo `{{n}}` diz o que o preenche e o que vai quando o CRM não tem o dado. Até aqui os
modelos eram criados por um script fora do sistema (`/root/relatorios/whatsapp-modelos/`), e o que preenche cada
campo estava fixo no código (`WA_TEMPLATE_FIELDS`, `packages/shared/src/whatsapp-art.ts`).

## Regras da Meta, que o sistema segue

- **O texto aprovado é o que vai.** No envio só os campos `{{n}}` mudam; o resto é o texto aprovado.
- **Editar manda de volta para a análise.** Um modelo editado volta para "Em análise na Meta" e só vale de novo
  depois de aprovado. A Meta deixa editar um modelo aprovado no máximo **1 vez por dia e 10 vezes em 30 dias**,
  e só os aprovados, recusados ou pausados (um modelo em análise espera a resposta). Nome, idioma e categoria
  não mudam: para isso, crie outro modelo.
- **Cada campo precisa de um exemplo** quando o modelo é criado ou editado: a Meta analisa o texto com ele.
- **Campo vazio a Meta recusa.** Por isso cada campo tem um texto para quando falta o dado (abaixo).
- **O que o sistema ainda não preenche não sai (fase 2b):** modelo com campo no título, botão de link com parte
  variável, ou cabeçalho de vídeo, documento ou localização. Antes ele saía só com o corpo preenchido e a Meta
  recusava (ou chegava cortado). Agora a escolha do modelo mostra "o sistema ainda não envia este", com o motivo,
  e o envio responde 422 `template_unsupported` sem chamar a Meta. Título e link fixos continuam valendo.
- **Número de trabalho (fase 2b):** cada número usa só os modelos aprovados da própria WABA, lidos da Meta com o
  token dele (`wa_number_templates`, a cada 6 h ou em "atualizar"). Criar e editar modelos nesta tela continua
  sendo só da WABA oficial.

## O que preenche cada campo

| Papel           | Vem de                                                        | Se faltar (padrão)       |
| --------------- | ------------------------------------------------------------- | ------------------------ |
| Nome do lead    | primeiro nome do lead (ou do perfil do WhatsApp)              | o texto que for definido |
| Seu nome        | primeiro nome de quem envia                                   | o texto que for definido |
| Empresa do lead | empresa do lead (formulário ou o campo Empresa da negociação) | **"sua empresa"**        |
| Marca           | a marca da conversa (Expansão: travada, não se escreve)       | o texto que for definido |
| Livre           | o vendedor escreve na hora (dia, hora, link)                  | o texto que for definido |

- Sem empresa, o modelo vai com "a sua empresa" ("transformar a sua empresa em franquia"), sempre no feminino,
  e a tela avisa "Sem dado no CRM, vai o texto padrão". O vendedor pode escrever outro valor no campo.
- Um campo sem dado e sem texto padrão continua bloqueando o envio até alguém escrever: a Meta não aceita vazio.
- Os campos ficam só no sistema (`wa_templates.fields`). Mudar só os campos não volta para a Meta.

## Pedido de permissão para ligar

- **No modelo:** ao criar ou editar, "Pedir permissão para ligar" acrescenta ao modelo o botão "Permitir
  ligações" da Meta (componente `call_permission_request`). Esse modelo vai sempre como modelo, mesmo dentro das
  24 h, e marca o contato como "pedido de ligação enviado". **Não verificado ao vivo:** o formato do componente
  segue a documentação da Meta, e nenhum modelo assim foi criado ainda.
- **"Prefiro uma ligação":** quando o lead toca nessa resposta rápida dos modelos de boas-vindas:
  - o dono da negociação ganha a tarefa "Ligar: o lead pediu uma ligação pelo WhatsApp", com prazo agora;
  - com o número oficial ligado (`official_number_live`) e as ligações ativas no número, o sistema manda na hora
    o pedido de permissão da Meta. O toque abriu a janela de 24 h.
  - Não manda de novo enquanto a pessoa permite ligações, nem duas vezes no mesmo dia (limite da Meta). Vai uma
    vez, sem nova tentativa.
- **Ligar pelo celular:** o painel de ligação tem "Ligar pelo celular" (link `tel:`), ao lado de "Abrir no
  WhatsApp do vendedor" e "Copiar número".

## Acesso e rotas

Permissão `whatsapp_templates.manage`: Admin Master e Diretoria. Nada aqui manda mensagem para ninguém. Cada
criação, edição e mudança de campos grava auditoria com o nome e o idioma do modelo, nunca o texto.

| Rota                                        | O quê                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `GET /whatsapp/templates/manage`            | Lê a lista da Meta e mostra todos, com status e motivo da recusa      |
| `POST /whatsapp/templates/manage`           | Cria o modelo na Meta (nasce em análise)                              |
| `PUT /whatsapp/templates/manage/:id`        | Edita o texto, os botões e o pedido de ligação (volta para a análise) |
| `PUT /whatsapp/templates/manage/:id/fields` | Muda só o que preenche cada campo e o texto padrão                    |

O status chega também pelo webhook `message_template_status_update`, com o motivo quando a Meta recusa.
Migração 0097: `wa_templates.rejected_reason` e `wa_templates.fields`.

## Não verificado ao vivo

- Criar e editar contra a Meta de verdade: os testes usam uma Meta simulada.
- Editar um modelo com arte reenvia o cabeçalho como a Meta o lista. A Meta pode pedir a imagem de exemplo de
  novo. Se recusar, a tela mostra o motivo, e o caminho é criar um modelo novo com a arte pelo script.
