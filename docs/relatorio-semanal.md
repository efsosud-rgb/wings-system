# Modelo do relatório de sexta

Relatório curto para o Eric, toda sexta. Cabe numa tela. Número sem fonte não entra: sem dado, escreva "—" e o motivo.

```markdown
# Semana de dd/mm a dd/mm/aaaa

## Fechou

- <o que entrou na develop ou na produção, com o número do PR>

## Ficou

- <o que não terminou, por quê, e quando volta>

## Depende do Eric

- <decisão, merge, deploy, credencial, verba: o que é e o que trava enquanto não sair>

## Números

| Item                        | Esta semana | Semana anterior | Fonte                         |
| --------------------------- | ----------- | --------------- | ----------------------------- |
| Leads que chegaram          |             |                 | CRM (consulta usada)          |
| Gasto em anúncios (R$)      |             |                 | Painel de mídia / gerenciador |
| Testes verdes (API / total) |             |                 | CI do último merge na develop |
| Fluxos de ponta a ponta     |             |                 | passo "pnpm e2e" da CI        |

## Riscos

- <o que pode dar errado, com o achado ou a invariante ligada (docs/invariantes.md)>
```
