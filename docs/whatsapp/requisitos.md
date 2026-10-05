# WhatsApp da Wings e Sofia (SDR) — requisitos

Versão de 04/10/2026. Fonte das decisões: Eric. Onde algo não foi decidido, está em "Perguntas em aberto" (fim de `regras-negocio.md`), nunca preenchido por suposição.

## Objetivo

Todo contato de lead pelo WhatsApp entra no Wings System, é pré-qualificado pela Sofia e chega ao vendedor certo dentro do CRM Vendas, com a conversa inteira gravada no lead.

## Decisões já tomadas

- Canal: API oficial da Meta (WhatsApp Business Platform / Cloud API). Não Z-API. (30/09/2026)
- Sem intermediário de dados: o Wings System fala direto com a Graph API da Meta. Se o backend for Node/TypeScript, usar o kit `@kapso/whatsapp-cloud-api` (MIT) no modo direto com a Meta (`accessToken`), nunca no modo proxy da Kapso.
- A Sofia só pré-qualifica e transfere; o vendedor assume dentro do CRM. IA da Sofia: DeepSeek via OpenRouter.
- A Sofia se apresenta sempre como "atendente virtual da Wings". Nunca se passa por uma pessoa.
- Todo atendimento passa pelo número comercial da Wings, iniciado e respondido de dentro do CRM (botão de conversa no lead).
- Produção é o único ambiente que fala com a Meta e com telefones reais. Nada vai para produção sem ordem do Eric.

## Escopo por fase

**Fase 1 (esta entrega, só homologação)**
1. Receber mensagens pelo webhook da Meta, validar a assinatura e gravar tudo.
2. Identificar a origem do contato (código no texto do link do site ou da LP; objeto `referral` dos anúncios de clique para WhatsApp).
3. Sofia: primeira resposta, identificação do interesse (Formatação, Expansão ou outro) e envio do WhatsApp Flow certo.
4. Receber a resposta do Flow, aplicar as regras de qualificação e criar ou atualizar o lead no CRM Vendas.
5. Distribuir o lead qualificado aleatoriamente entre os vendedores do setor; não qualificado vira perda com motivo.
6. Tela de conversa dentro do lead: histórico, envio de resposta pelo vendedor, status de entrega.
7. Painel técnico: webhooks recebidos, erros da Meta, mensagens não entregues.

**Fase 2**: agendamento da reunião dentro do Flow com horários reais da agenda (endpoint de dados do Flow + Google Calendar), follow-up automático da Sofia, opções de campanha ativas vindas do CRM.

**Fase 3**: voz (ligação e áudio). Fora do escopo agora.

## Requisitos não funcionais

- **Segurança:** token da Meta, App Secret e chaves só em variáveis do Coolify; nunca no repositório, no chat ou em log. Validar `X-Hub-Signature-256` (HMAC SHA-256 com o App Secret) em todo POST do webhook; responder 200 rápido e processar em fila.
- **Idempotência:** a Meta reenvia webhooks; chave única pelo `wamid` da mensagem e pelo id do status.
- **Janela de 24 h:** resposta livre só dentro da janela de atendimento; fora dela, só modelo de mensagem aprovado. O sistema bloqueia o envio livre fora da janela e oferece os modelos.
- **LGPD:** coletar só o necessário; aviso de privacidade no Flow com link para a política; atender pedido de exclusão; "SAIR" ou "PARAR" interrompe mensagens ativas; reter o payload bruto do webhook por no máximo 90 dias.
- **Multi-tenant:** `tenant_id` em todas as tabelas novas (o Wings System será SaaS).
- **Nunca inventar dado:** painel sem dado mostra "—" e o motivo.
- **Testes:** cobertura do validador de assinatura, idempotência, janela de 24 h, regras de qualificação e distribuição; testes com payloads reais de exemplo da Meta.

## Ambientes

- **Homologação:** número de teste que a Meta dá ao criar o app (envia para até 5 números cadastrados). Não usa o número comercial. Isso é uma exceção à regra de 19/09 (homologação sem telefone): depende do OK do Eric.
- **Produção:** número comercial da Wings, só depois do OK do Eric e da decisão sobre a migração do número (ver `integracoes.md`).

## Critérios de aceite da fase 1

1. Mensagem enviada do celular de teste aparece no Wings System em até 5 s, gravada uma vez só.
2. Lead de teste vindo de link com código chega com origem correta.
3. Sofia responde se apresentando como atendente virtual e envia o Flow certo.
4. Resposta do Flow cria o lead qualificado no funil certo, com vendedor sorteado, ou a perda com motivo.
5. Vendedor responde de dentro do lead e vê "entregue" e "lida".
6. Webhook com assinatura inválida é recusado e registrado.
7. Envio livre fora da janela de 24 h é bloqueado.
