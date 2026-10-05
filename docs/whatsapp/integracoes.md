# Integrações — WhatsApp e Sofia

Versão de 04/10/2026.

## 1. Meta — WhatsApp Cloud API (direto, sem intermediário)

- **App:** Meta for Developers, tipo Business, ligado ao portfólio da Wings, com o produto WhatsApp.
- **Homologação:** número de teste que a Meta cria junto com o app; envia para até 5 números cadastrados. Não usa o número comercial (depende do OK do Eric, pergunta 5).
- **Token:** token permanente de Usuário do Sistema (Configurações do negócio → Usuários do sistema) com `whatsapp_business_messaging` e `whatsapp_business_management`. Quem cria e cola no Coolify é o Eric; o terminal nunca vê nem imprime o valor.
- **Webhook:** endpoint HTTPS do wings-api (em homologação, no domínio de staging). `GET` responde o `hub.challenge` com o token de verificação; `POST` valida `X-Hub-Signature-256` com o App Secret antes de qualquer coisa. Assinar os campos `messages` (traz também os status) e `message_template_status_update`.
- **Versão da Graph API:** fixar a versão estável mais recente no dia da implementação, num único lugar da configuração.
- **Kit:** se o backend for Node/TypeScript, `@kapso/whatsapp-cloud-api` (licença MIT) no modo direto com a Meta, `new WhatsAppClient({ accessToken })`. Ele cobre mensagens, modelos, Flows, mídia, verificação de assinatura e normalização do webhook. Nunca configurar `baseUrl` da Kapso nem `kapsoApiKey`. Se o backend for outra linguagem, chamar a Graph API por HTTP com o mesmo desenho.

## 2. WhatsApp Flows

- Rascunhos: `flow-expansao.json` e `flow-formatacao.json` (Flow JSON 7.3, a mais recente no changelog da Meta em set/2025; usar a mais nova no dia).
- Fase 1 sem endpoint de dados: não precisa de chave de criptografia. A resposta chega pelo webhook como mensagem interativa `nfm_reply`, com o `response_json`.
- Envio: mensagem interativa do tipo `flow` com `flow_id`, `flow_cta`, `flow_token` único por conversa (guardado em `wa_flow_resposta`), ação `navigate` para a primeira tela e os dados iniciais: `marca` e `campanhas` (lista das campanhas ativas, com a opção "Não vi anúncio").
- Validar e publicar no Gerenciador do WhatsApp → Flows (o editor aponta erro de JSON). Segundo a Kapso, Flows exigem o portfólio da empresa verificado na Meta; confirmar no Gerenciador.
- Fora da janela de 24 h, o Flow só vai dentro de um modelo aprovado com botão de Flow.

## 3. Número comercial (decisão do Eric, pergunta 4)

Hoje o número comercial está conectado à Z-API por uma sessão do app. Caminhos para a Cloud API:

| Caminho | O que acontece |
|---|---|
| A. Coexistência | O número continua no app WhatsApp Business e passa a funcionar também pela API, com histórico sincronizado. Aparelhos conectados (como a sessão da Z-API) são desligados; o app precisa ser aberto pelo menos a cada 13 dias; sem selo azul e sem API de chamadas. |
| B. Número novo só para a API | Nada muda no número atual; links do site e das LPs passam a apontar para o novo número. |
| C. Migração total | O número sai do app e fica só na API; o histórico do app não vai junto. |

Antes de qualquer caminho: listar tudo o que ainda usa a Z-API (WingsBot/OpenClaw, avisos internos) e decidir o destino de cada um.

## 4. OpenRouter (cérebro da Sofia)

- DeepSeek via OpenRouter (decidido). Prompt versionado no repositório; a versão vai em `sofia_qualificacao.versao_prompt`.
- Entrada: só a conversa atual e as respostas do Flow. Saída em JSON: `segmento`, `resposta`, `transferir_humano`, `motivo`.
- Se a IA falhar ou demorar mais de 15 s: mensagem fixa ("Já vou te passar para um consultor") e transferência para humano.
- Nas configurações de privacidade da OpenRouter, desligar provedores que treinam com os dados enviados.

## 5. CRM Vendas (interno)

- Criar ou atualizar o lead (sem duplicar pelo telefone), definir funil e etapa, sortear o vendedor, gravar mensagens no lead.
- Botão "Conversar" no lead abre a conversa; o envio do vendedor passa pelo mesmo serviço que a Sofia usa.

## 6. RD Station (transição)

Se a fase 1 chegar à produção antes do CRM Vendas, a negociação também precisa ser criada no RD CRM, funil Expansão, "Novo Contato" (regra de 28/09; pergunta 6).

## 7. Google Calendar (fase 2)

Agendamento com horários livres do vendedor dentro do Flow, por endpoint de dados (exige a chave de criptografia do Flow por número).

## 8. Custos

- Meta: cobra cada mensagem de modelo entregue (marketing, utilidade, autenticação), com preço por país; respostas dentro da janela de 24 h não são cobradas. Conferir a tabela oficial antes de ligar follow-ups por modelo.
- OpenRouter: tokens da Sofia.
- Kit e Flows: sem custo.
