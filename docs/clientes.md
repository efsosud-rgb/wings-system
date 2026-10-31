# Formatação → Clientes: cadastro e ficha

Os clientes da Wings são empresas em formatação para virar franqueadoras. O
cadastro tem duas partes:

- **Cadastro rápido**, na lista: nome e, quando já se sabe, CNPJ (o botão
  Buscar traz o nome da Receita) e contato principal (nome, e-mail, WhatsApp).
  Cadastrar abre a pasta `Clientes/<NN. Nome>` no Drive e o projeto em Gestão
  → Projetos, como antes.
- **Ficha completa** (`/formatacao/clientes/:id`), uma aba por bloco,
  cada uma salva sozinha, com "% preenchido" no topo e o que falta em cada
  aba. É dela que o Jurídico vai tirar os contratos e a COF
  (Lei 13.966/2019). A Wings Company não tem ficha.

O contrato fica em `packages/shared/src/client-record.ts` (schemas, vocabulários
e `clientCompleteness`). A API responde a cada gravação com a ficha inteira,
com o % recalculado.

## Blocos e tabelas (migração `0037_client_record`)

| Bloco                   | Onde fica                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Empresa              | colunas novas em `clients` (razão social, CNPJ único por tenant, IE, IM, abertura, natureza jurídica, regime, CNAEs, capital, endereço, telefone, e-mail, site, redes) |
| 2. Sócios               | `client_partners` (N por cliente)                                                                                                                                      |
| 3. Contatos do projeto  | `client_contacts` (um por papel: principal, financeiro, marketing)                                                                                                     |
| 4. Negócio atual        | `client_business` (1:1)                                                                                                                                                |
| 5. Contrato com a Wings | `client_contracts` (N) e `client_contract_consultants` (um funcionário por área da Formatação)                                                                         |
| 6. Franquia planejada   | `client_franchise_plans` (1:1) e `client_unit_models` (N); a área de expansão continua em `clients.expansion_area`                                                     |
| 7. Assinatura           | `client_signatures` (1:1) e `client_witnesses` (até 2)                                                                                                                 |

Dinheiro em centavos, percentuais com duas casas. A migração dá `GRANT SELECT`
das tabelas novas (e de `clients` de novo) a `wings_ro` quando o papel existe.

Os documentos (contrato social, cartão CNPJ, documentos dos sócios) não ficam
na ficha: vão para `Clientes/<NN. Nome>/Documentos Enviados` no Drive, e a
ficha só leva até essa pasta.

## Permissões

| Permissão           | Quem                               | O que dá                                                                           |
| ------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| `clients.manage`    | Admin Master, Diretoria, Marketing | cadastrar, renomear, desativar, links e regras de origem                           |
| `clients.read`      | os mesmos e Jurídico               | ver a lista e a ficha                                                              |
| `clients.edit`      | os mesmos e Jurídico               | preencher a ficha; consultar CNPJ e CEP                                            |
| `clients.sensitive` | Admin Master, Diretoria, Jurídico  | ver e gravar CPF, estado civil e regime de bens dos sócios e o CPF das testemunhas |

Sem `clients.sensitive`, a API devolve esses campos nulos (`restricted: true`,
só `cpfOnFile` diz se há CPF) e recusa com 403 `sensitive_forbidden` quem os
envia; gravar os outros campos mantém os sensíveis como estão. Com a
permissão, o CPF chega mascarado (`***.456.789-**`); o completo só por
`POST /clients/:id/reveal-cpf`, uma revelação por vez, cada uma no
`audit_log` (`client.cpf_revealed`).

## CPF dos sócios

Guardado como o dos funcionários: AES-256-GCM com `CPF_ENCRYPTION_KEY` e índice
cego HMAC com `CPF_INDEX_KEY`. A mesma pessoa pode ser sócia de vários
clientes, então o CPF é único **dentro do cliente**
(`client_partners_client_cpf_idx`), não no sistema.

## CNPJ e CEP

`POST /clients/lookup/cnpj { cnpj }` e `POST /clients/lookup/cep { cep }`
(POST para o número não ir parar numa URL nem no log de requisições). CNPJ:
BrasilAPI, e a ReceitaWS se a BrasilAPI falhar. CEP: BrasilAPI v2, e o ViaCEP
se falhar. A resposta só preenche o formulário; nada é gravado até alguém
salvar. Do quadro de sócios da Receita vêm só nome e qualificação (a Receita
mascara o CPF, e nós nem o repassamos); a tela oferece "adicionar como sócio".

Respostas ficam uma hora em memória. "Não encontrado" responde 404; os dois
fornecedores fora do ar, 503 com "preencha à mão". Falha vai para o log só como
fornecedor, status e `shapeOf` do corpo. Limite de 20 consultas por minuto por
IP.

O CNPJ alfanumérico (em emissão desde julho de 2026) é validado
(`isValidCnpj`). Se BrasilAPI e ReceitaWS já o consultam **não foi verificado**.

Formatos conferidos contra os serviços reais em 2026-09-24: BrasilAPI CNPJ v1
(`razao_social`, `nome_fantasia`, `cnae_fiscal`, `cnaes_secundarios`,
`codigo_natureza_juridica`, `regime_tributario[]`, `qsa[]`…), ReceitaWS
(`nome`, `fantasia`, `abertura` dd/mm/aaaa, `atividade_principal[]`…),
BrasilAPI CEP v2 (`street`, `neighborhood`, `city`, `state`) e ViaCEP
(`logradouro`, `bairro`, `localidade`, `uf`; `{ erro: "true" }` para CEP
inexistente).

## Auditoria

Toda gravação escreve no `audit_log`, com `entity = 'client'`, **só nomes de
campos**, nunca valores: `client.created` (`withCnpj`, `withContact`),
`client.company_updated`, `client.partner_created|updated|deleted`,
`client.contacts_updated` (papéis), `client.business_updated`,
`client.contracts_updated`, `client.franchise_updated`,
`client.signature_updated` e `client.cpf_revealed`.

## Fica para a onda do Jurídico/Documenso

- variáveis de modelo (`{{empresa.razao_social}}`,
  `{{socio_1.qualificacao_completa}}`…) e a pré-visualização (parte B desta
  onda);
- editor de modelos, geração de contrato e COF pela IA do Jurídico;
- instalação do Documenso, envio para assinatura e status;
- revisão jurídica do que a COF exige e das regras de testemunhas e foro.

## Cadastro novo (30/09/2026)

"Novo cliente" (Formatação → Clientes) passou a exigir: **CNPJ** (Buscar preenche
razão social, nome fantasia, CNAE, abertura e cidade/UF pela Receita via
BrasilAPI; o que a Receita não disser fica para a pessoa), **contato principal**
com e-mail e WhatsApp, **relação com a Wings** (`clients.relationship`:
Formatação, Expansão ou ambos) e o **perfil de franquia** do plano do CRM
(segmento, unidades, faixa de faturamento — "não informado" é resposta —,
franqueabilidade e fit Wings — "não avaliado" é resposta —, fonte e data do
dado; migração 0054 em `client_business`). O projeto de Formatação só abre
quando a relação inclui Formatação. Cadastros antigos ficam como estão, com o
selo **"Cadastro incompleto"** e a lista do que falta (`clientRegisterMissing`,
`registerMissing` em `GET /clients`); completam-se pela ficha, e a relação
pelo `PATCH /clients/:id`.

## WhatsApp da marca (09/10/2026)

Na ficha de uma marca de Expansão (ou "ambos"), o quadro "WhatsApp da marca" guarda a **arte do cabeçalho** dos
modelos (PNG ou JPEG, 1125 × 600, até 2 MB, na pasta Mídia da marca no Drive) e o **artigo** do nome (o/a: "do
Casal do Churros", "da Malkuth"). A arte da Wings, dos modelos da Formatação, fica em Formatação → Clientes.
Migração 0081 (`clients.article`, `clients.whatsapp_art_file_id`, `clients.whatsapp_art_set_at`). Detalhes em
`docs/whatsapp/arte-modelos.md`.

## Negociações, reuniões, arquivos e linha do tempo (29/10/2026)

O menu: Clientes fica em Formatação desde 30/09 (`/administracao/clientes` redireciona). Não há atalho em
Administração: a documentação não diz que a Administração usa a tela, e quem tem `clients.read` a vê em
Formatação.

A ficha ganhou a aba **Negociações**, depois dos sete blocos (não conta no "% preenchido"). Ela lista as
negociações das empresas do CRM ligadas ao cliente (`crm_companies.client_id`, que o "Virar cliente" de CRM
Vendas → Empresas preenche) e, para a negociação escolhida, mostra os mesmos componentes da ficha do lead:
**Linha do tempo** (`Timeline`), **Reuniões** (`MeetingsTab`) e **Arquivos** (`FilesTab`). Na ficha do
cliente tudo é só leitura; anotar, marcar reunião e enviar arquivo continuam na página da negociação, aberta
pelo nome dela. Sem tabela nem migração nova: tudo já estava no banco.

`GET /clients/:id/deals` exige `clients.read` **e** `leads.read`, e devolve só as negociações no escopo de
`leads.read` de quem pede (próprio ou todos), como em Empresas. Hoje isso dá a aba a Admin Master e
Diretoria. Jurídico e Marketing leem a ficha, mas não o CRM: para eles a aba não aparece e a API responde 403. Contatos, contrato e dados da empresa continuam nos blocos 1, 3 e 5; os documentos, na pasta do Drive.
