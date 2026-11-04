# Editar os dados de contato do lead (t089)

Pedido do Eric (03/11/2026): o vendedor ficava preso ao telefone e ao e-mail que vieram da prospecção ou do cadastro. Agora a ficha corrige nome, telefone, e-mail, Instagram e site.

## Na tela

Cartão **Contatos** da negociação: **Editar dados** abre o formulário no mesmo padrão dos outros (Nome, Telefone, E-mail, Instagram, Site) e **Histórico dos dados** lista quem mudou o quê, quando e o valor que estava antes. Só aparece para quem pode editar (`canWrite`); a decisão é da API.

## Regras

- **Validação** em `packages/shared/src/lead-contact.ts` (`checkLeadContactUpdate`), a mesma na tela e na API. Telefone: DDD existente + número, com ou sem máscara, `+55` ou 0 na frente; celular de 8 dígitos ganha o 9; fixo começa com 2 a 5. E-mail: endereço completo, sem pontos duplos. Instagram e site pelos normalizadores de `lead-fields.ts`. Vazio limpa telefone, e-mail, Instagram e site; o nome não se limpa; a negociação não fica sem telefone **e** sem e-mail.
- **Gravado normalizado**: telefone só dígitos com 55, e-mail em minúsculas, Instagram sem `@`, site com `https://`.
- **Quem edita**: `leads.write` no escopo da pessoa (`access.ts`): o dono da negociação, o gerente comercial e o Admin Master. Diretoria não tem `leads.write` e não edita; vendedor sem posse recebe 404 (a negociação nem aparece). Ver `permissoes-por-dono.md`.
- **Outra negociação com o mesmo telefone ou e-mail**: um vendedor é recusado com 409 `contact_in_use`, sem dizer nada da outra negociação (mesma regra da criação e da importação, `mergeOnlyIfOwnedBy`). Admin e gerente podem. Também recusa número em atendimento sem negociação (WA-03).
- **Trilha**: tabela `lead_contact_changes` (migração 0112): lead, campo, valor antes, valor depois, quem, quando. Só é lida por `GET /leads/:id/contact-changes` (`leads.read`, no escopo do lead). **Sem `GRANT` para `wings_ro`, sem view**: nenhum relatório, BI ou consulta de staging lê. Um teste confere que nenhuma migração a expõe. A linha do tempo recebe `lead.contact_changed` e a auditoria `lead.contact_updated`, ambas só com os **nomes** dos campos.
- **Onde o dado novo passa a valer**: WhatsApp, ligação, e-mail e as automações leem `leads.phone`/`leads.email` na hora de agir, então o número novo é o canal na mesma hora. O contato principal da negociação (`crm_contacts`) acompanha quando tinha o mesmo valor (um segundo contato nunca é tocado; se outra pessoa já tem aquele telefone ou e-mail, o contato fica como estava). As conferências guardadas do campo trocado (`field_checks`: WhatsApp, Instagram, site) saem e a ficha mostra "Não conferido ainda".
- **"Não me contate" não se perde**: antes de trocar telefone, e-mail ou Instagram, o que estiver ativo para a negociação é gravado também nas chaves novas (origem mantida, motivo "Mantido ao alterar os dados de contato"). Só gerência e diretoria revogam, como sempre. Vale para toda origem, inclusive a Prospecção Instagram, o SAIR, a importação e o CRM gravados só por uma chave (testado por origem). Só fica de fora o que a Prospecção deriva da tabela `prospects` (chaves `place_id` e do lead, que não mudam).

## Limites conhecidos

- A conversa antiga do WhatsApp fica no número antigo; a ficha abre a conversa do número novo. Mensagem que o número antigo mandar depois já não acha esta negociação.
- Renomear pelo cabeçalho (`PATCH /leads/:id/deal`) continua gravando `lead.renamed` na linha do tempo e não entra em `lead_contact_changes`; a edição pelo cartão Contatos entra.
- O veredito do Instagram (suspeito/falso) não é refeito ao trocar o @.

## Testes

`packages/shared/src/lead-contact.test.ts` (validação), `apps/api/src/modules/leads/contact-edit.test.ts` (validação pela API, permissões, histórico sem valores na linha do tempo e na auditoria, sem `GRANT`, WhatsApp e contato principal, conferência velha, conflito, "não me contate" por origem e só pela chave que muda), `apps/web/src/pages/crm/LeadContactEditor.test.tsx`.
