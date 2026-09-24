# Navegação: módulos, sub-módulos e studios (Fase 0)

Esqueleto de navegação. **Nenhuma lógica de negócio nova, nenhum backend
novo** — só a casa onde o resto vai morar.

## O padrão

**Módulo (expansível) → Sub-módulo → Studio**, replicado em todos os módulos.
A árvore inteira vive em `packages/shared/src/navigation.ts` e é a **fonte
única**: dela saem o menu, as rotas e as regras de acesso.

Isso não é organização por gosto. Antes, menu e rotas eram constantes
separadas, e era possível registrar uma sem a outra — foi exatamente assim que
`/ponto` e `/configuracoes` viraram entradas de menu apontando para telas que
nunca existiram, devolvendo 404 a quem clicasse.

> ⚠️ **`/ponto` e `/configuracoes` nunca foram telas.** Estavam no menu antigo,
> mas não havia rota nem página. Não são migrações da Fase 0: entraram como
> "em breve", como qualquer sub-módulo sem tela. **Não procure funcionalidade
> que nunca existiu.**

## Estados de um sub-módulo

| Estado        | O que significa                                         |
| ------------- | ------------------------------------------------------- |
| `ready`       | tem tela e backend; **exige permissão** (teste garante) |
| `coming_soon` | sem backend; aparece no menu, marcado "em breve"        |

Um sub-módulo sem backend fica **visível e marcado**, nunca escondido: a forma
do sistema é legível por inteiro, e ninguém confunde "não construído" com
"quebrou ao carregar".

## Permissões

Só existem 15 permissões, cobrindo funcionários, ponto, leads, configurações,
APIs, auditoria e ads. Contratos, Formatação, Gestão, Produtividade e
Atendimento **não têm permissão definida** — e inventar essa matriz seria
decisão de negócio, não esqueleto. (Desde então ganharam permissão os módulos
que foram construídos: Drive, clientes, mídia, integrações e, em Gestão,
Projetos com `projects.read` e `projects.manage`; ver `docs/projetos.md`.)

Regra aplicada:

- sub-módulo **construído** → sempre atrás da sua permissão real;
- sub-módulo **em breve** → visível, exceto onde o módulo é sensível;
- **Administração**: todo sub-módulo exige permissão, senão o módulo inteiro
  apareceria para qualquer um (foi o que um teste pegou);
- **SaaS**: restrito a Admin Master por papel, não por permissão.

## Telas que mudaram de endereço

O código das telas **não mudou** — mesmo arquivo, mesmo componente, novo
endereço. Só o alvo dos links internos foi atualizado.

| Antes                      | Agora                                      |
| -------------------------- | ------------------------------------------ |
| `/trafego-pago`            | `/dashboard/marketing` (é relatório)       |
| `/trafego-pago/aprovacoes` | `/marketing/trafego-pago-wings/aprovacoes` |
| `/funcionarios`            | `/administracao/usuarios`                  |
| `/ponto`                   | `/gestao/rh-dp` (em breve)                 |
| `/configuracoes`           | `/administracao/configuracoes` (em breve)  |

O cockpit é **relatório de campanhas**, não studio: mora no Dashboard. O studio
do agente é outra coisa — conversa e ferramentas.

### Redirects são obrigatórios

`LEGACY_REDIRECTS` mantém todos os endereços antigos funcionando, **com o
sufixo preservado**: `/trafego-pago/aprovacoes/<id>` chega na mesma aprovação
no endereço novo.

Isso não é cortesia. A mensagem de aprovação no WhatsApp carrega esse link com
o id dentro, e **mensagens já enviadas não podem ser editadas**. Um 404 aí já
custou uma etapa inteira.

## Layout de studio

`StudioLayout` é um componente só, parametrizável: conversa de um lado,
ferramentas do outro. Todos os agentes usarão o mesmo.

**O chat não está implementado** — é placeholder, e diz isso na tela. O que já
funciona são as ferramentas: no studio de Tráfego Pago, os links para
aprovações e para o relatório.

## Gate de permissão no frontend

`ProtectedRoute` só pergunta "você está logado?". `RequirePermission` fecha o
furo: quem digitasse `/administracao/usuarios` sem `employees.read` via a tela
montar e encher de erro — nada vazava, porque a API recusava tudo, mas a
página parecia quebrada em vez de honesta.

Continua sendo conveniência, **não segurança**: a API é a autoridade e
reverifica cada requisição.

## Onde "/" leva

`LandingRoute` manda para a primeira tela que a pessoa **realmente pode abrir**.
Antes ia fixo para a lista de funcionários, errado para quem não tem
`employees.read`.
