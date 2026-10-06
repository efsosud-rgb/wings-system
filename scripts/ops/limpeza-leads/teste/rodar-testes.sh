#!/usr/bin/env bash
# Testa a limpeza dos leads com dados fictícios (dados.sql) em bancos descartáveis do Postgres
# de desenvolvimento (contêiner wings-system-db-dev): um com o esquema da produção (origin/main)
# e um com o do staging (origin/develop). Roda o script de operação de verdade (ALVO=local):
# simular não muda nada; aplicar faz o que verificar-aplicado.sql espera; o plano que cresce
# depois da simulação e uma tabela desconhecida ligada a leads param tudo; desfazer volta ao
# retrato de antes; desfazer duas vezes é recusado.
#
#   bash scripts/ops/limpeza-leads/teste/rodar-testes.sh [ref ...]
set -euo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$AQUI/../limpar-leads.sh"
RAIZ=$(git -C "$AQUI" rev-parse --show-toplevel)
TMP=$(mktemp -d)
[ "${MANTER:-}" = 1 ] && echo "temporários em $TMP" || trap 'rm -rf "$TMP"' EXIT
[ $# -gt 0 ] || set -- origin/main origin/develop

P() { docker exec -i wings-system-db-dev psql -X -q -U wings -v ON_ERROR_STOP=1 "$@"; }
falha() { echo "FALHOU ($ref): $*" >&2; exit 1; }
tem() { grep -qxF -- "$2" "$1" || { echo "--- saída:" >&2; cat "$1" >&2; falha "faltou a linha: $2"; }; }
limpar() { sleep 1; ALVO=local LOCAL_DB=$db RD_IDS=$TMP/rd-ids LOGDIR=$TMP/logs-$n bash "$SCRIPT" "$@"; }
retrato() {
  P -d "$db" <"$AQUI/retrato.sql"
  [ "$develop" = t ] || return 0
  P -d "$db" -At <<'SQL'
select t, md5(coalesce(string_agg(linha, '|' order by linha), '')) from (
  select 'lead_files' as t, to_jsonb(x)::text as linha from lead_files x
  union all select 'crm_meetings', to_jsonb(x)::text from crm_meetings x
  union all select 'crm_meeting_analysis_runs', to_jsonb(x)::text from crm_meeting_analysis_runs x
) a group by t order by t;
SQL
}

printf 'rdT1\nrdT5\n' >"$TMP/rd-ids"
n=0
for ref in "$@"; do
  n=$((n + 1))
  db="wings_limpeza_teste_$n"
  echo "== $ref ($db)"
  mkdir -p "$TMP/mig-$n"
  git -C "$RAIZ" archive "$ref" apps/api/migrations | tar -x -C "$TMP/mig-$n"
  P -d postgres -c "drop database if exists $db" -c "create database $db" 2>&1 | grep -v NOTICE || true
  for tag in $(node -e 'for (const e of require(process.argv[1]).entries) console.log(e.tag)' "$TMP/mig-$n/apps/api/migrations/meta/_journal.json"); do
    P -d "$db" -1 <"$TMP/mig-$n/apps/api/migrations/$tag.sql" >/dev/null 2>&1 || falha "migração $tag"
  done
  P -d "$db" <"$AQUI/dados.sql" >/dev/null
  develop=$(P -d "$db" -At -c "select to_regclass('public.lead_files') is not null")
  [ "$develop" = t ] && P -d "$db" <"$AQUI/dados-develop.sql" >/dev/null

  antes=$(retrato)

  # 1. simular: os números do plano, e nada muda
  limpar simular >"$TMP/sim.out" 2>&1 || { cat "$TMP/sim.out" >&2; falha "simular"; }
  tem "$TMP/sim.out" 'teste por campo: nome 6, e-mail 1, empresa 2, nome do negócio no RD 2, motivo de perda 1, marcado no painel 1'
  tem "$TMP/sim.out" 'teste: 11 lead(s) (do lote rd-crm-20261006T1840Z: 5; de outros lotes do RD: 0; sem lote: 6)'
  tem "$TMP/sim.out" 'teste por funil: expansao 5, formatacao 4, sem funil 2'
  tem "$TMP/sim.out" 'teste com cara de negociação de verdade: 3 (ganha 1, etapa 3 ou mais 1, com contrato 1) -> ficam (para apagar também: APAGAR_SUSPEITOS=1)'
  tem "$TMP/sim.out" 'teste a apagar: 8'
  tem "$TMP/sim.out" 'repetidos: telefones/e-mails ignorados: 1 da própria Wings, 1 em mais de 5 leads (8 lead(s) nesses)'
  tem "$TMP/sim.out" 'repetidos: 9 grupo(s) (só telefone 4, só e-mail 4, os dois 1); maior grupo: 3 leads; 1 telefone(s) juntam números gravados com e sem o 9'
  tem "$TMP/sim.out" 'repetidos em conflito (ficam separados): 4 grupo(s), 8 lead(s) (duas ganhas 1, ganha e aberta 1, abertas em funis diferentes 1, abertas com donos diferentes 1)'
  tem "$TMP/sim.out" 'repetidos a juntar: 5 grupo(s); 6 lead(s) somem e o que tinham passa para o que fica'
  tem "$TMP/sim.out" 'repetidos por funil (dos que somem): expansao 4, formatacao 2'
  tem "$TMP/sim.out" 'aviso: 1 teste(s) e 1 repetido(s) que somem têm negócio do RD criado nos últimos 3 dias; com o seguimento do RD ligado, podem voltar na hora seguinte'
  tem "$TMP/sim.out" 'PLANO: apagar=8 juntar=6'
  tem "$TMP/sim.out" 'SIMULAÇÃO: nada foi gravado'
  if [ "$develop" = t ]; then
    tem "$TMP/sim.out" 'feito: 8 lead(s) de teste apagados com 15 linha(s) ligadas; 1 linha(s) soltas do lead (marca da Meta, contrato); 1 contato(s) e 1 empresa(s) de teste'
    tem "$TMP/sim.out" 'feito: 6 lead(s) repetidos juntados em 5; 12 linha(s) passaram para o lead que fica; 2 vínculo(s) repetido(s) removidos'
  else
    tem "$TMP/sim.out" 'feito: 8 lead(s) de teste apagados com 12 linha(s) ligadas; 1 linha(s) soltas do lead (marca da Meta, contrato); 1 contato(s) e 1 empresa(s) de teste'
    tem "$TMP/sim.out" 'feito: 6 lead(s) repetidos juntados em 5; 10 linha(s) passaram para o lead que fica; 1 vínculo(s) repetido(s) removidos'
  fi
  tem "$TMP/sim.out" 'leads: 41 antes, 27 agora'
  if grep -qE '@|5511|Teste Silva|Dup Um' "$TMP/sim.out"; then falha "a tela mostrou dado de pessoa"; fi
  [ "$(retrato)" = "$antes" ] || falha "a simulação mudou o banco"

  # 2. o plano cresceu depois da simulação: aplicar recusa
  P -d "$db" -c "insert into leads (source, name) select 'manual', 'teste extra ' || g from generate_series(1, 20) g" >/dev/null
  if echo PRODUCAO | limpar aplicar >"$TMP/cresceu.out" 2>&1; then falha "aplicou com o plano maior"; fi
  tem "$TMP/cresceu.out" 'ERRO: o plano mudou desde a simulação (apagar: 28 agora, 8 na simulação); simule de novo'
  P -d "$db" -c "delete from leads where name like 'teste extra %'" >/dev/null
  [ "$(retrato)" = "$antes" ] || falha "a recusa mudou o banco"

  # 3. uma tabela nova ligada a leads: para antes de mexer
  P -d "$db" -c "create table zz_nova (id uuid primary key, lead_id uuid references leads(id))" >/dev/null
  if limpar simular >"$TMP/nova.out" 2>&1; then falha "rodou com tabela desconhecida"; fi
  tem "$TMP/nova.out" 'ERRO: tabela ligada a leads que este script não conhece: zz_nova (revise o script)'
  P -d "$db" -c "drop table zz_nova" >/dev/null

  # 4. aplicar
  limpar simular >"$TMP/sim2.out" 2>&1 || falha "simular de novo"
  echo PRODUCAO | limpar aplicar >"$TMP/apl.out" 2>&1 || { cat "$TMP/apl.out" >&2; falha "aplicar"; }
  tem "$TMP/apl.out" 'APLICADO'
  P -d "$db" <"$AQUI/verificar-aplicado.sql" >/dev/null || falha "verificar-aplicado"
  if [ "$develop" = t ]; then
    v=$(P -d "$db" -At -c "select (select count(*) from lead_files where drive_file_id = 'dfa00000-0000-4000-8000-000000000001'), (select count(*) from lead_files where lead_id = 'aaaaaaaa-0000-4000-8000-000000000011'), (select count(*) from crm_meetings), (select count(*) from crm_meeting_analysis_runs)")
    [ "$v" = "1|2|1|1" ] || falha "develop: arquivos/reuniões depois de aplicar: $v"
  fi
  lote=$(sed -n 's/^LOTE PARA DESFAZER: //p' "$TMP/apl.out")
  [ -n "$lote" ] || falha "sem lote"

  # 5. de novo: não há mais o que fazer (os suspeitos e os conflitos continuam lá)
  limpar simular >"$TMP/sim3.out" 2>&1 || falha "simular depois de aplicar"
  tem "$TMP/sim3.out" 'teste a apagar: 0'
  tem "$TMP/sim3.out" 'repetidos a juntar: 0 grupo(s); 0 lead(s) somem e o que tinham passa para o que fica'

  # 6. desfazer volta ao retrato de antes; uma segunda vez é recusada
  echo PRODUCAO | limpar desfazer "$lote" >"$TMP/desf.out" 2>&1 || { cat "$TMP/desf.out" >&2; falha "desfazer"; }
  if [ "$develop" = t ]; then
    tem "$TMP/desf.out" 'desfeito: 14 lead(s) de volta; 19 outra(s) linha(s) re-inseridas; 12 linha(s) devolvidas ao lead de antes; 1 religada(s) ao lead (marca da Meta, contrato)'
  else
    tem "$TMP/desf.out" 'desfeito: 14 lead(s) de volta; 15 outra(s) linha(s) re-inseridas; 10 linha(s) devolvidas ao lead de antes; 1 religada(s) ao lead (marca da Meta, contrato)'
  fi
  [ "$(retrato | grep -v '^ops|')" = "$(echo "$antes" | grep -v '^ops|')" ] || {
    diff <(echo "$antes") <(retrato) >&2 || true
    falha "desfazer não voltou ao retrato de antes"
  }
  if echo PRODUCAO | limpar desfazer "$lote" >"$TMP/desf2.out" 2>&1; then falha "desfez duas vezes"; fi
  tem "$TMP/desf2.out" "ERRO: lote $lote já foi desfeito em $(P -d "$db" -At -c "select undone_at from ops.lead_cleanup_runs where batch_id = '$lote'")"

  P -d postgres -c "drop database $db" >/dev/null
  echo "   ok"
done
echo "todos os testes passaram"
