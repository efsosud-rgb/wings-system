# Limpeza dos leads (testes e repetidos)

Pedido do Eric (06/10, depois da importação do RD na produção): apagar de vez os leads de teste
e juntar os repetidos num lead só, sem mexer no RD. Código em `scripts/ops/limpeza-leads/`.

É SQL puro, rodado no contêiner do banco: não depende de deploy. Vale para a produção em
`0501fcf` (migrações até a 0070). As tabelas que vieram depois (`lead_files`, `crm_meetings`)
são tratadas quando existem, como no staging. Se aparecer uma tabela ligada a `leads` que o
script não conhece, ele para antes de mexer em qualquer coisa.

## Como rodar (produção: quem roda é o Eric)

Os arquivos ficam em `/root/relatorios/limpeza-leads/` (cópia desta pasta). Antes de aplicar,
faça o backup do banco no Coolify.

```bash
bash /root/relatorios/limpeza-leads/limpar-leads.sh simular     # não grava nada
bash /root/relatorios/limpeza-leads/limpar-leads.sh aplicar     # pede PRODUCAO
bash /root/relatorios/limpeza-leads/limpar-leads.sh desfazer limpeza-leads-AAAAMMDDTHHMMSSZ
```

- **simular** faz todo o trabalho numa transação e a desfaz no fim (`ROLLBACK`). Na tela só
  saem contagens. O log completo vai para `/root/relatorios/logs-limpeza-leads/` (permissão 600):
  traz os ids dos leads para conferir na tela do CRM, nunca nome, e-mail ou telefone.
- **aplicar** só roda num terminal interativo, pedindo PRODUCAO. Exige uma simulação de menos de
  24 h, terminada sem erro e com os mesmos parâmetros. Se o plano crescer mais de 10% (no mínimo
  5 leads) desde aquela simulação, para e pede outra. Tudo vai numa transação só: se cair no
  meio, nada fica pela metade.
- **desfazer LOTE** primeiro simula o desfazer e mostra as contagens. Depois pede PRODUCAO.
- Variáveis opcionais:
  - `APAGAR_SUSPEITOS=1`: veja "Leads de teste".
  - `LIMITE_CHAVE=5`: veja "Repetidos".
  - `SEM_RD=1`: não lê o RD; os testes saem só do banco.
  - `ALVO=staging`: só simula.

Enquanto roda, ninguém grava em `leads` (as leituras seguem). Isso dura segundos; quem chega
nesse instante (webhook, importação) espera.

## Leads de teste

Um lead é de teste quando algum destes campos tem uma palavra que começa com "teste" (teste,
testes, teste1…), sem diferenciar maiúsculas e acentos:

- o nome do lead;
- o e-mail do lead;
- o nome da empresa do lead;
- o motivo de perda.

Também é de teste quando o negócio do RD que ele segue é de teste:

- pelo nome lido no RD na hora (só leitura, cerca de 1 minuto);
- ou pela marca do painel (`rd_crm_deals`/`campaign_leads`).

Para o RD vale a mesma regra do painel e da importação, `isTestDeal`: a palavra "teste" inteira
no nome do negócio ou no motivo de perda. A importação de 06/10 (lote `rd-crm-20261006T1840Z`)
contou 60 negócios assim, mas não os marcou no banco; o nome do negócio não fica no lead, por
isso o script lê o RD.

**Com cara de negociação de verdade** (ganha, aberta em etapa 3 ou mais, ou com contrato): fica,
e o id vai para o log para conferir. Com `APAGAR_SUSPEITOS=1`, vai junto.

Ao apagar um teste:

- Somem as linhas ligadas a ele: eventos, notas, tarefas, atividades, histórico de etapas,
  avisos, automações e seus e-mails, vínculos com contatos e arquivos, reuniões e o registro
  de custo da pesquisa.
- A marca da Meta (`meta_leadgen_events`) fica, só sem o lead: é ela que impede a leitura da
  Meta de trazer o mesmo lead de novo.
- Um contrato ficaria do mesmo jeito, sem o lead.
- Contatos e empresas que só existiam para os testes também somem, quando eles mesmos têm
  "teste" no nome ou no e-mail.

## Repetidos

Dois leads são a mesma pessoa quando têm o mesmo WhatsApp ou o mesmo e-mail. Em cadeia também:
A e B com o mesmo telefone, B e C com o mesmo e-mail, os três são um. Nome igual sozinho não
junta.

- **Telefone:** a regra de `normalizeBrazilianPhone` (55 + DDD + número). Um celular gravado
  sem o 9 (12 dígitos, começando em 6–9 depois do DDD) conta como o mesmo com o 9.
- **E-mail:** sem espaços e em minúsculas.
- **Não juntam:**
  - telefones e e-mails da própria Wings (funcionários, links de WhatsApp, clientes) digitados
    num lead;
  - um telefone/e-mail presente em mais de `LIMITE_CHAVE` leads (padrão 5), que é enfeite do
    tipo "naotem@…".

**Conflito: o grupo fica separado** e os ids vão para o log, para uma pessoa decidir. Juntar
apagaria uma negociação viva quando o grupo tem:

- duas ganhas;
- uma ganha e uma aberta;
- abertas em funis diferentes;
- abertas com donos diferentes.

**Quem fica:** a ganha, senão a aberta, senão a perdida. Empatou, vale nesta ordem:

1. a que tem dono;
2. a tocada no Wings System (`managed_by = 'wings'`);
3. a de etapa mais adiantada;
4. a mais antiga.

**O que o lead que fica herda:** só o que está vazio nele, como uma chegada repetida faz hoje:

- nome, e-mail e telefone;
- dados do WhatsApp, primeira mensagem, cidade e respostas do formulário;
- base legal com o consentimento;
- canal, página, campanha e formulário;
- marca, empresa, valor, previsão e dono;
- a atribuição inteira, se ele não tiver nenhuma;
- o cliente, se ele não tiver um definido;
- o funil, se ele não tiver etapa.

Etapa, resultado e negócio do RD continuam os dele.

**O que muda para o lead que fica:**

- As linhas dos outros passam para ele: eventos, notas, tarefas, atividades, histórico,
  avisos, automações, e-mails, arquivos, reuniões, marca da Meta e contrato. Um vínculo que
  ele já tinha (o mesmo contato, o mesmo arquivo) não é duplicado.
- A junção fica no histórico dele: evento `lead.duplicates_merged`, com id, origem, funil,
  etapa, resultado e negócio do RD de cada um que sumiu. Até a ficha ganhar o rótulo, aparece
  como "Atualização".
- O lote fica na auditoria (`leads.cleanup`).

## Cópia e desfazer

Antes de apagar ou mudar qualquer linha, o script guarda uma cópia em `ops.lead_cleanup_rows`
(o resumo do lote fica em `ops.lead_cleanup_runs`). Fica no mesmo banco e com a mesma proteção;
o `wings_ro` não lê esse esquema.

O desfazer, para um lote:

- devolve os leads apagados com tudo o que tinham;
- devolve as linhas que mudaram de lead;
- no lead que ficou, volta só os campos que a junção escreveu e que ninguém mudou depois;
- marca o lote como desfeito. Não desfaz duas vezes.

Ele para sem gravar nada se um lead devolvido colidir com um que chegou depois (o mesmo negócio
do RD importado de novo, por exemplo).

Com a cópia guardada, apagar o esquema `ops` é decisão do Eric.

**Lote do RD:** para desfazer a importação `rd-crm-20261006T1840Z` depois desta limpeza, desfaça
antes a limpeza. Senão o desfazer do RD apaga o lead que ficou com as linhas que vieram dos
repetidos.

**Seguimento do RD:** a cada hora, com `CRM_RD_FOLLOW_ENABLED`, ele traz de novo os negócios do
RD criados nos últimos 3 dias que não acha no Funil. A simulação conta quantos dos que somem
estão nessa janela (linha "aviso:"). Um teste recente apagado pode voltar enquanto o negócio
existir no RD.

## Testes (dados fictícios, banco descartável)

```bash
bash scripts/ops/limpeza-leads/teste/rodar-testes.sh                 # origin/main e origin/develop
MANTER=1 bash scripts/ops/limpeza-leads/teste/rodar-testes.sh origin/main
```

Para cada esquema, o teste:

- cria um banco no `wings-system-db-dev` a partir das migrações da ref e carrega `dados.sql`
  (mais `dados-develop.sql` quando há `lead_files`);
- roda o script de operação de verdade (`ALVO=local`);
- confere:
  - as contagens da simulação, e que ela não muda nada;
  - a recusa quando o plano cresce e quando aparece uma tabela nova ligada a leads;
  - o resultado de aplicar (`verificar-aplicado.sql`);
  - que uma segunda simulação não acha mais nada;
  - que o desfazer volta ao retrato exato de antes;
  - a recusa de desfazer duas vezes.
