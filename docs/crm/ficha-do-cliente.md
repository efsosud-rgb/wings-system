# Ficha do cliente (a página da negociação)

Branch `feat/ficha-cliente` (06/10/2026), sobre o develop 7a6349b. Pedido do Eric: "desenvolver as ferramentas de uso do vendedor dentro do card do lead". Tudo o que o vendedor usa no dia resolve dentro de `/crm-vendas/negociacoes/:id`; um vendedor só abre as próprias negociações (`leads.read`/`leads.write` no escopo `own`, decididos na API).

## O que há na página

- **Cabeçalho**: nome editável (Enter grava, Esc cancela; `PATCH /leads/:id/deal { name }`, evento `lead.renamed`), etiquetas de funil, origem e marca, "Nova" enquanto o primeiro contato está aberto; empresa, valor, previsão de fechamento (com "vencida"), dono, "Criada em"; **Marcar venda** / **Marcar perda** (motivo). Barra de etapas clicável, com os dias na etapa atual.
- **Barra de ações**: Anotação, E-mail, Ligação, WhatsApp (em breve), Reunião (agendar pela API, link colado), Tarefa, Mais (registrar reunião feita; abrir a cópia no RD). WhatsApp, vídeo e agenda do Google ficam "em breve" até as contas de API serem ligadas; nenhum link externo do WhatsApp.
- **Faixa do primeiro contato**: "Nova negociação: faça o primeiro contato até HH:MM" (1 hora útil; `lead_tasks` kind `first_contact`), com Ligar e "Contato feito".
- **Esquerda**: "Sobre a negociação" (campos nossos editáveis no lugar; respostas do formulário só leitura; "Personalizar" escolhe e ordena campos, guardado no navegador em `crm.deal.fields`) e Contatos (copiar telefone/e-mail, "+ Adicionar contato").
- **Centro**: Resumo da IA (abaixo), Próximas tarefas (sem o primeiro contato, que tem a faixa), Registrar (anotação, tarefa, ligação com resultado/duração/observação e telefone para copiar, reunião feita com data/participantes/link) e as **seções**: Histórico (linha do tempo com filtro por tipo), E-mail (aba existente; segue em modo de teste), Tarefas (abertas com caixa, concluídas depois), Questionários (respostas do formulário e primeira mensagem), Arquivos, Propostas (em breve).
- **Direita**: Contatos, Empresa, Propostas e Arquivos com contagem e "+ Adicionar".

## Arquivos (migração 0071)

- `lead_files` (`lead_id`, `drive_file_id`, `added_by`, `created_at`; único por lead + arquivo). O arquivo é do Drive: nome, bytes e acesso continuam lá. A linha só diz "este arquivo é desta negociação".
- Rotas: `GET /leads/:id/files`; `POST /leads/:id/files/uploads` → ticket do Drive; `POST /leads/:id/files/uploads/:uploadId/complete`; `POST /leads/:id/files { fileId }` liga um arquivo já existente; `DELETE /leads/:id/files/:fileId` tira da negociação e deixa no Drive. Leitura com `leads.read`, escrita com `leads.write`, sempre no escopo do caller; o envio exige ainda `drive.write` em Comercial (vendedores têm).
- Pasta: `Comercial / Negociações / <nome da negociação>`, criada na primeira vez; outra negociação com o mesmo nome ganha " (2)". Barras e caracteres de controle viram "-".
- Eventos `lead.file_added` / `lead.file_removed` e auditoria só com o id do arquivo, nunca o nome.

## Resumo da IA (migração 0071, coluna `leads.ai_summary`)

- `POST /leads/:id/resumo` (`leads.write`) gera e grava `{ text, generatedAt, model, basedOn: { events, answers } }`; evento `lead.summary_generated` com modelo, custo e contagens (nunca o texto). `POST /leads/:id/resumo/pergunta { question }` (`leads.read`) responde e **não grava nada**.
- **O que vai ao modelo**: só a linha do tempo (etapas, anotações, ligações, reuniões, tarefas, eventos do sistema) e as respostas do formulário, mais funil/etapa/situação. **Nunca** nome, telefone, e-mail, CPF ou outro documento: perguntas do formulário sobre contato ou documento ficam de fora; todo o texto passa pelo scrubber do agente (`modules/agent/scrub.ts`) e, por cima, sequências de 8 a 14 dígitos e CNPJ são removidas (`scrubForModel`). A resposta do modelo passa pelo mesmo filtro antes de ser gravada. Teste: `modules/leads/summary.test.ts`.
- **Modelo**: `anthropic/claude-sonnet-5` pelo OpenRouter (`OPENROUTER_API_KEY`), com `provider.data_collection = "deny"` (opção `noDataCollection` do helper): o OpenRouter só roteia para provedores que não guardam nem treinam com o prompt. A Anthropic não treina com dados da API; pode reter até 30 dias para prevenção de abuso, salvo conta com retenção zero. No painel do OpenRouter, o registro de prompts da conta deve ficar desligado (padrão).
- Sem chave: 503 `ai_unavailable`; a tela mostra "—" com o motivo. O modelo é instruído a dizer "não consta no registro" em vez de inventar.

## Testes e capturas

- API: `deal-page.test.ts` (nome), `lead-files.test.ts` (Drive, pasta, remoção, escopo), `summary.test.ts` (texto sem dados pessoais, gravação, pergunta, 503).
- Web: `DealPage.test.tsx` (previsão) e `DealPageHead.test.tsx` (cabeçalho, barra, faixa, Sobre, Personalizar, contatos, cartões, resumo, seções).
- Capturas a 1440 e 390 px ao fim de cada etapa (sem rolagem lateral a 390).

## Depois da Etapa 5 (mesma branch)

- Em "Sobre a negociação", a linha "Preencheu o formulário em DD/MM/AAAA HH:MM" (`consent.consentedAt`), só para leads da Meta e do TikTok.
- **Conversa do WhatsApp** (`/crm-vendas/negociacoes/:id/whatsapp`, `DealWhatsAppPage`): conversa no centro, campo de mensagem embaixo, painel à direita com Visão geral, Anotações (funcionam) e Arquivos (os da negociação); ligação de voz e vídeo no topo. Até a API oficial do WhatsApp ser ligada, abre vazia (sem mensagem de exemplo), com envio, ligação e vídeo desabilitados "em breve". A ação WhatsApp da barra e o ícone ao lado do telefone abrem a tela. Para o vendedor, enquanto o número oficial não estiver ligado (`official_number_live`), a ação mostra "em breve", a conversa só lê e o painel de ligação só copia e registra; a API recusa o envio e a ligação (403 `whatsapp_soon`).
- **Reunião** (seção do centro, `DealMeetings.tsx`, sobre a API de reuniões do Opus — `docs/crm/reunioes-api.md`, tipos em `@wings/shared/meetings`; ligada em 2026-10-06): **Agendar reunião** marca pela API (`POST /leads/:id/meetings`) com título, início/fim, agenda do vendedor ou da Wings e o **link colado** (Meet, Zoom ou Teams, validado pelo esquema compartilhado antes de pedir); "Criar o evento e o Meet pelo Google" pede `createMeet` e, ao 503 `google_not_connected`, a tela diz que o Google ainda não está autorizado (Thais) e volta ao link colado. **Iniciar reunião** abre, ao lado do Wings (`window.open(..., 'wings-meet', 'popup…')`), a reunião em andamento ou a próxima marcada com link (`meetingToStart`); sem nenhuma, fica desabilitado com o motivo. Por reunião (`GET /meetings/:id`): **cancelar** (`PATCH` com `status: cancelada`, só agendada); **gravação** — "Enviar gravação" pede o endereço assinado (`recording/upload-url`, tipo e tamanho exatos), manda o arquivo por `PUT` com os cabeçalhos dados e confirma em `recording/complete`; "Ouvir" pede o link de 5 minutos na hora e nunca o guarda; **transcrição** (`GET /transcript`, só ao clicar em "ler") com as vozes nomeáveis (`PATCH /speakers`) ou o motivo de não haver separação; **resumo/análise** com "Analisar agora/de novo" (`POST /analysis`, conta no teto diário), participantes, assuntos, próximos compromissos ("Virar tarefa") e avaliação; sem dado, "—" com o motivo. Em **Expansão**, o cartão **Resumo para o dono da franqueadora**: "Gerar rascunho" (`POST /summary-send`, canal e-mail ou WhatsApp, só com a análise pronta), "Editar texto" (`PATCH`, só rascunho), e para quem tem `meetings.approve_send`: **"Li e aprovo este texto"** envia à API **exatamente o texto exibido na tela, como veio do servidor** (`POST /approve { text }`; a API recusa com `draft_changed` se alguém editou depois da leitura; o botão some enquanto se edita), "Enviar agora (uma vez)" (`POST /send`) e "Recusar". Estados, destinatário mascarado, aprovação e envio aparecem na linha de status. O campo "Cliente (marca franqueadora)" e as reuniões registradas à mão (`lead_activities`) continuam.

## Fica para depois

- Propostas; a API oficial do WhatsApp; a integração do Google (agenda, Meet, gravação) e as rotas de reuniões (Opus).
