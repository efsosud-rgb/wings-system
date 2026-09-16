# Ponto eletrônico (RH/DP)

> ## ⚠️ PENDENTE DE VALIDAÇÃO JURÍDICA
>
> A conformidade com a **Portaria MTP 671/2021** ainda **não foi confirmada**
> pelo Jurídico. O modelo de dados foi construído para ser compatível, mas o
> sistema **não pode ser usado para folha de pagamento** até a aprovação
> formal. Mantenha este aviso visível até lá.

## Regras acordadas (2026-09-15)

| Item                 | Valor                                                  |
| -------------------- | ------------------------------------------------------ |
| Jornada padrão       | 09:00–18:00, segunda a sexta                           |
| Tolerância de atraso | 30 minutos                                             |
| Intervalo            | 60 minutos (padrão)                                    |
| Fuso de cálculo      | `America/Sao_Paulo` (o servidor roda em UTC)           |
| Isentos de ponto     | Admin Master e Diretoria (`roles.tracks_time = false`) |

## Modelo de dados

- `time_entries` — **append-only**, garantido por trigger no banco
  (`wings_forbid_update_delete`). Cada registro carrega `source`:
  `login`, `logout`, `session_timeout`, `manual_adjustment` ou `import`.
- `time_adjustments` — correções passam por aqui, com motivo, solicitante e
  aprovador. A aprovação **insere uma nova linha** em `time_entries`; nada é
  editado.
- `daily_timesheets` — consolidação diária (horas trabalhadas, atraso, falta).
  Sempre recalculável a partir de `time_entries`.
- `work_schedules` / `holidays` — jornada padrão e calendário de feriados.

## Pontos em aberto

1. Confirmação do Jurídico sobre a Portaria 671/2021 (inclusive se o login
   pode ser considerado marcação de ponto).
2. Logout não é confiável (fechar a aba não gera logout): a sessão expira por
   inatividade e o fechamento usa o último instante de atividade registrado.
3. Calendário de feriados: nacionais, estaduais e municipais a definir.
4. Formato de exportação (AFD ou equivalente) a definir após a validação legal.
