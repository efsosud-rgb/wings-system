# Estrutura de dados — WhatsApp e Sofia

Versão de 04/10/2026. PostgreSQL. Nomes são proposta: siga o padrão de nomes, migrações e multi-tenant que o projeto já usa. Todas as tabelas têm `tenant_id`.

## Tabelas operacionais

| Tabela | Para que serve | Campos principais |
|---|---|---|
| `wa_contato` | Quem fala com a Wings | `telefone_e164` (único por tenant), `wa_id`, `nome_perfil`, `lead_id` (CRM), `opt_out_em`, `criado_em` |
| `wa_conversa` | Cada atendimento | `contato_id`, `status` (aberta, com_vendedor, encerrada), `janela_expira_em` (última mensagem do lead + 24 h), `origem_codigo`, `referral` (jsonb do anúncio), `segmento`, `atribuido_a` (usuário), `criado_em` |
| `wa_mensagem` | Toda mensagem, nos dois sentidos | `wamid` (único), `conversa_id`, `direcao` (entrada, saída), `autor` (lead, sofia, vendedor, sistema), `tipo` (texto, interativo, flow, modelo, imagem, áudio, documento), `conteudo` (jsonb), `texto` (busca), `status` (enviada, entregue, lida, falhou), `erro_codigo`, `erro_detalhe`, `enviada_em`, `entregue_em`, `lida_em` |
| `wa_webhook_evento` | Registro bruto de cada chamada da Meta | `recebido_em`, `assinatura_ok`, `payload` (jsonb), `processado_em`, `erro`. Apagar depois de 90 dias |
| `wa_flow` | Flows publicados | `nome` (expansao, formatacao), `meta_flow_id`, `versao_flow_json`, `status` (rascunho, publicado), `publicado_em` |
| `wa_flow_resposta` | Respostas dos Flows | `flow_token` (único), `conversa_id`, `flow_id`, `resposta` (jsonb), `recebida_em`, `lead_id` |
| `wa_modelo` | Modelos de mensagem aprovados | `nome`, `categoria` (marketing, utility, authentication), `idioma`, `status_meta`, `componentes` (jsonb) |
| `sofia_qualificacao` | O que a Sofia decidiu e por quê | `conversa_id`, `lead_id`, `segmento`, `marca_interesse`, `origem`, `campanha`, `respostas` (jsonb), `resultado` (qualificado, perda, transferido_humano), `motivo_perda_id`, `modelo_ia`, `versao_prompt`, `criado_em` |

## Índices e restrições

- Únicos: `wa_mensagem.wamid`; `wa_contato (tenant_id, telefone_e164)`; `wa_flow_resposta.flow_token`.
- Busca: `wa_mensagem (conversa_id, criado_em)`; `wa_conversa (atribuido_a, status)`; `wa_webhook_evento (recebido_em)` para a limpeza de 90 dias.
- Status de mensagem só avança (enviada → entregue → lida); status que chega fora de ordem não volta atrás.

## Dados pessoais

- Telefone e nome são dados pessoais: acesso pelo RBAC do lead (vendedor só vê os seus) e mascarados em log (`+55 21 9****-**88`).
- Nada de dado sensível na ficha da Sofia (saúde, religião etc.). Se o lead mandar, não vai para campos estruturados.
- Opt-out grava `opt_out_em` e bloqueia mensagens ativas para o contato.

## Ligação com o BI (schema `dw`, já desenhado)

- `dim_canal`: o canal `whatsapp` já está semeado.
- `dim_origem`: vem de `origem_codigo` ou do `referral` do anúncio (`tipo_origem` = WhatsApp).
- `dim_marca`: marca de interesse dos leads de Expansão.
- `fato_conversao`: uma linha quando o lead entra pelo WhatsApp (canal, origem, campanha, marca).
- `fato_negociacao` e `fato_funil_diario`: o resultado da Sofia (qualificado, perda com `dim_motivo_perda`) aparece como etapa do funil.
- A carga (ETL) fica para depois; aqui só garanta que esses campos existam e estejam preenchidos na origem.
