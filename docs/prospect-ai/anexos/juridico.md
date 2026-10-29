# Anexo jurídico — Wings Prospect AI (rascunho para o advogado)

> **Tudo neste anexo está marcado "a validar".** É um rascunho técnico escrito a partir do plano de 29/10/2026 e do código do Wings System (commit `c4168cb`). Não é parecer jurídico. Cada frase entre aspas é uma proposta de texto; o advogado pode reescrever.

Referências: Guia orientativo de legítimo interesse da ANPD (2024); LGPD arts. 6º, 7º (V e IX), 10, 16, 18, 33, 37 e 41; Resolução CD/ANPD nº 2/2022 (agentes de pequeno porte) e nº 19/2024 (transferência internacional); Termos da Plataforma da Meta, item 3.a; Termos do Google Maps Platform.

---

## 1. Teste de legítimo interesse (LIA) — Prospecção pelo Google Maps

**Tratamento:** o vendedor busca empresas no Google Maps pelo CRM, vê nome, endereço, telefone e site na tela, reserva a empresa e liga. O banco guarda só o `place_id` do Google e o que o vendedor anotar. Quando a empresa é MEI ou o telefone é celular do dono, há dado pessoal.

### Fase 1 — Finalidade (o interesse é legítimo?) — a validar
| Pergunta do guia | Resposta proposta |
|---|---|
| Qual o interesse? | Oferecer a empresas os serviços B2B da Wings (formatação de franquias, consultoria empresarial, mentoria). Interesse comercial da própria Wings (art. 10, I: "apoio e promoção de atividades do controlador"). |
| É lícito? | Sim: prospecção B2B por telefone é atividade lícita; o dado vem de ficha pública que a própria empresa publicou para receber contato comercial. |
| É concreto e atual? | Sim: cada busca é feita por um vendedor identificado, para um segmento e local definidos, e fica registrada (livro `prospect_calls`). |
| A finalidade é específica? | Sim: primeiro contato comercial com a empresa. Não há revenda, enriquecimento de perfil nem uso para outra finalidade. |

### Fase 2 — Necessidade (o mínimo de dados?) — a validar
- O sistema **não grava** nome, endereço, telefone nem nota vindos do Google: só o `place_id` (há teste automático que falha se isso mudar).
- O vendedor usa o telefone que a empresa publicou como canal comercial. Não se busca celular pessoal do sócio em outras fontes.
- Enriquecimento pelo site da empresa (e-mail e links publicados no site) fica guardado por prazo limitado (proposta: 180 dias sem uso; ver §5).
- Não há alternativa menos invasiva para o primeiro contato com quem ainda não conhece a Wings, além de anúncio (que já é usado em paralelo).

### Fase 3 — Balanceamento e salvaguardas — a validar
| Risco ao titular | Salvaguarda |
|---|---|
| Expectativa: o dono de MEI pode não esperar ligação comercial | A ligação é feita a quem publicou o número como comercial; na primeira frase o vendedor diz quem é a Wings e **onde achou o contato** ("vi a sua empresa no Google Maps"). |
| Contato insistente | Limite de 40 consultas por vendedor por dia; reserva com dono único (uma empresa não recebe várias abordagens); reserva expira (PR `fix/prospeccao-ajustes`). |
| Oposição ignorada | "Não me contate" imediato, gravado no cadastro único `contact_opt_outs` e consultado por todo envio (PR `feat/trava-unica-contato`). |
| WhatsApp sem permissão | A trava atual bloqueia WhatsApp para empresa que não aceitou (`packages/shared/src/prospecting.ts:557-566`). |
| Transparência | Aviso na política de privacidade do site (seção "Prospecção de empresas"), com o canal do encarregado. |

**Conclusão proposta:** interesse legítimo (art. 7º, IX) aplicável, com as salvaguardas acima. **A validar.**

---

## 2. Teste de legítimo interesse — Instagram da Wings

Há três tratamentos diferentes no Instagram. Base legal proposta por tratamento:

| Tratamento | Quem iniciou | Base proposta |
|---|---|---|
| A. Resposta privada automática a quem comentou a palavra-chave (ex.: FRANQUIA) num post ou anúncio da Wings | A pessoa (comentou a palavra que o post pede para comentar) | Procedimentos preliminares a pedido do titular (art. 7º, V) **ou** legítimo interesse (art. 7º, IX). Recomendação: tratar como **legítimo interesse** para a primeira resposta (o pedido é implícito) e como **art. 7º, V** quando a pessoa responde no Direct ou preenche o diagnóstico. |
| B. Direct recebido (a pessoa escreveu primeiro) | A pessoa | Art. 7º, V (procedimentos preliminares a pedido do titular). |
| C. Radar de concorrentes: o vendedor lê no Instagram comentários públicos em posts de concorrentes e registra **só empresas** | A Wings | Legítimo interesse, **só para empresas** e contato só pelo canal comercial publicado pela empresa. Pessoa física fica fora (a tela bloqueia). |

### Fase 1 — Finalidade — a validar
- A e B: atender um pedido de informação que a própria pessoa fez em canal da Wings. Interesse concreto (há um comentário ou mensagem identificável, com data e link guardados como evidência).
- C: oferecer serviços B2B a empresas que manifestaram publicamente uma necessidade que a Wings atende. Finalidade específica: um primeiro contato pelo canal oficial da empresa.

### Fase 2 — Necessidade — a validar
- Guardamos o id da pessoa no Instagram (IGSID, um número que só vale para o app da Wings), o @, o trecho mínimo do comentário (até 280 caracteres) e o link. Nada de foto, seguidores, bio, telefone achado em outro lugar ou perfil montado (Termos da Plataforma da Meta, 3.a.v).
- Ao classificador de IA vai **só o texto**, sem @, nome ou telefone.
- No radar (C) o sistema guarda só metadados públicos dos posts do concorrente (id, link, data, legenda curta, número de comentários), por 30 dias. Os comentários não são lidos por máquina; o vendedor lê no Instagram e registra só a empresa.

### Fase 3 — Balanceamento e salvaguardas — a validar
| Risco | Salvaguarda |
|---|---|
| Mensagem inesperada | Só uma resposta privada por comentário, só até 7 dias (regra da Meta), texto fixo aprovado pelo Eric, nunca escrito por IA, com aviso de privacidade (§3). |
| Insistência | Depois da resposta automática, nada sai sem resposta da pessoa; no Direct, só dentro de 24 h da última mensagem dela (regra da Meta). |
| Oposição | "Parar" ou "não quero" registra "não me contate" (canal Instagram) e bloqueia novas respostas automáticas. |
| Decisão automatizada | A IA só sugere categoria e intenção; um humano revisa antes de qualquer contato que não seja a resposta automática. Nenhuma característica pessoal (idade, sexo, saúde, família) entra na nota. |
| Dados de quem não virou lead | Apagados em 90 dias (§5). |
| Concorrentes (C) | Sem coleta automática de comentários; sem pessoa física; sem envio em massa; contato um a um pelo canal oficial da empresa; guarda o link público que motivou o contato. |

**Conclusão proposta:** A e B cabem em art. 7º, V / IX com aviso na primeira mensagem; C cabe em legítimo interesse **somente para empresas**. **A validar.** Ponto de atenção: em 2024 a ANPD suspendeu o uso amplo de posts públicos pela Meta para treinar IA; aqui não há treino nem coleta em massa.

---

## 3. Avisos de privacidade (textos propostos) — a validar

Os textos ficam em Ajustes (`prospect_ai_settings.settings.messages`) e só o gerente edita, com auditoria. O código **não** aceita texto vazio nem gerado por IA.

**3.1 Resposta privada ao comentário (primeira mensagem)** — limite prático de 1.000 caracteres:
> "Oi! Aqui é a Wings Company. Vi que você comentou FRANQUIA no nosso post e separei o diagnóstico gratuito: {link_diagnostico}
> Se preferir, me conta aqui em uma frase o que você quer: franquear a sua empresa ou abrir uma franquia?
> Usamos só o que você escrever aqui para responder ao seu pedido. Para não receber mais mensagens, responda PARAR. Privacidade: {link_politica}"

**3.2 Primeira resposta humana no Direct** (sugestão de texto para o vendedor; não automática):
> "Oi, {primeiro_nome_se_informado}! Aqui é {vendedor}, da Wings. Usamos os dados desta conversa só para te atender. Política de privacidade: {link_politica}."

**3.3 Primeira ligação da prospecção Google (roteiro):**
> "Bom dia, aqui é {vendedor}, da Wings Company, consultoria de franquias e gestão. Encontrei a {empresa} no Google Maps. Posso falar dois minutos com o responsável? … Se preferir que a gente não ligue mais, eu registro agora."

**3.4 Contato com empresa vinda do radar (canal oficial da empresa):**
> "Olá, aqui é {vendedor}, da Wings Company. Vimos no Instagram que a {empresa} comentou sobre {tema}. Trabalhamos com {serviço}. Faz sentido conversar? Se não quiser receber contato, é só responder e não falaremos mais."

**3.5 Política de privacidade do site** precisa ganhar (a validar): controlador e encarregado (art. 41); finalidades por fonte (Google, Instagram, anúncios, formulários); bases legais (§1 e §2); provedores no exterior (Meta, Google, OpenRouter e provedores de IA) e as cláusulas-padrão da Resolução CD/ANPD nº 19/2024; prazos (§5); como pedir acesso, correção, exclusão e oposição (art. 18); e a URL de **exclusão de dados** exigida pela Meta (ver checklist da Fase 2 na especificação, §10). Hoje o repositório registra que a política "não existe" (`docs/ads/fechar-ciclo.md:21`), e o CRM aponta para `https://wingscompany.com.br/politica-de-privacidade/` (`apps/web/src/components/campaign-builder/LeadFormSection.tsx:48`).

---

## 4. Transferência internacional e operadores — a validar
| Provedor | Dado que recebe | Situação |
|---|---|---|
| Meta (Instagram) | O que a pessoa já publicou na Meta; a resposta da Wings | Termos da Plataforma; conferir cláusulas-padrão |
| OpenRouter → Anthropic (classificador) | Só o texto do comentário/mensagem, sem @, nome ou telefone; pedido `data_collection: deny` | Conferir contrato e cláusulas-padrão (Res. 19/2024; prazo de adequação venceu em ago/2025) |
| Google (Places) | Texto da busca do vendedor | Termos do Google Maps Platform |

---

## 5. Prazos de retenção propostos — a validar

Todos configuráveis em Ajustes, com faixa mínima e máxima no Zod, e aplicados por um agendador de limpeza (PR C7). O padrão abaixo é o que o código usa até o advogado decidir.

| Dado | Tabela | Prazo proposto | Depois do prazo |
|---|---|---|---|
| Corpo bruto do webhook do Instagram | `ig_webhook_events.payload` | 30 dias após processado (falha: 90 dias) | Apaga o `payload`; mantém id, tipo, status e datas |
| Oportunidade que **não** virou lead (rejeitada, duplicada, prazo vencido ou parada) | `prospect_opportunities` + `prospect_evidence` | 90 dias após o fechamento (ou 90 dias sem mudança) | Apaga a linha da evidência e anonimiza a oportunidade (sem trecho, sem IGSID, sem @); o painel mantém só a contagem |
| Evidência de oportunidade que virou lead | `prospect_evidence` | Enquanto o lead existir | Segue a política de retenção do lead (a definir) |
| Pessoa do Instagram sem lead | `ig_people` | 90 dias da última interação | Apaga |
| Respostas privadas enviadas | `ig_private_replies` | 180 dias (prova de "uma por comentário") | Apaga o id do destinatário; mantém contagem |
| Posts do radar | `competitor_posts` | 30 dias | Apaga |
| Cache do classificador | `prospect_classifier_cache` | 30 dias (só hash e resultado; o texto não é guardado) | Apaga |
| Registro de ligação | `prospect_call_logs` | 24 meses | Apaga as notas; mantém resultado e data para o painel |
| Enriquecimento pelo site | `prospects.enrichment` | 180 dias sem uso (PR `fix/prospeccao-ajustes`) | Limpa |
| "Não me contate" | `contact_opt_outs` (PR `feat/trava-unica-contato`) | Enquanto vigente | Necessário para respeitar a oposição |

## 6. Perguntas diretas para o advogado
1. Para a resposta automática ao comentário, o advogado prefere art. 7º, V ou IX? (§2)
2. Os prazos do §5 servem? Em especial os 90 dias para quem não virou lead.
3. O radar de concorrentes (§2-C), restrito a empresas e com contato pelo canal oficial delas, é aceitável? MEI conta como "empresa" para esse fim?
4. O texto da primeira mensagem (§3.1) cumpre o dever de informação do art. 9º?
5. A Wings se enquadra como agente de pequeno porte (Res. 2/2022)? Isso muda o encarregado e o registro de operações.
6. Quais cláusulas-padrão (Res. 19/2024) faltam nos contratos com Meta, Google e OpenRouter?
