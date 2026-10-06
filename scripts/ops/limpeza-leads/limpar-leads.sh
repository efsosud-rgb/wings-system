#!/usr/bin/env bash
# Limpeza dos leads do Funil (docs/crm/limpeza-leads.md): apaga os leads de teste e junta os
# repetidos (mesmo WhatsApp ou mesmo e-mail) num lead só. Não mexe no RD (só lê nele os nomes
# dos negócios, para achar os de teste).
#
#   bash limpar-leads.sh simular           # faz tudo numa transação e desfaz; NÃO grava nada
#   bash limpar-leads.sh aplicar           # grava; pede PRODUCAO; exige simulação de menos de 24 h
#   bash limpar-leads.sh desfazer LOTE     # simula o desfazer, mostra, e pede PRODUCAO para valer
#
# Variáveis opcionais:
#   APAGAR_SUSPEITOS=1  apaga também os "teste" ganhos, em etapa 3 ou mais, ou com contrato
#   LIMITE_CHAVE=5      um telefone/e-mail presente em mais leads do que isto não junta ninguém
#   SEM_RD=1            não lê o RD; acha os testes só pelo banco (nome, e-mail, empresa, motivo de perda)
#   ALVO=staging        só simular (o desfazer também só simula)
# Na tela saem apenas contagens e códigos. O log completo (com ids de lead para conferir na
# tela do CRM, nunca nome, e-mail ou telefone) vai para um arquivo com permissão 600.
set -euo pipefail
umask 077

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MODO=${1:-}
LOTE_DESFAZER=${2:-}
ALVO=${ALVO:-prod}
LIMITE_CHAVE=${LIMITE_CHAVE:-5}
APAGAR_SUSPEITOS=${APAGAR_SUSPEITOS:-0}
SEM_RD=${SEM_RD:-0}
LOGDIR=${LOGDIR:-/root/relatorios/logs-limpeza-leads}
BANCO=wings_system

uso() { echo "uso: bash $0 simular | aplicar | desfazer LOTE" >&2; exit 2; }
case "$MODO" in simular | aplicar) ;; desfazer) [ -n "$LOTE_DESFAZER" ] || uso ;; *) uso ;; esac
case "$ALVO" in
  prod) API=engmbukkyuk3d07qqolmm5xt; DB=ihlubefwotdit6ugxezlnuhf ;;
  staging) API=39k6fbobdibfx96xz1p8gqkv; DB=q5kvm2ygakmm34rjwwir4rhj ;;
  # Testes com dados fictícios no Postgres de desenvolvimento: LOCAL_DB=<banco>, RD_IDS=<arquivo>.
  local) API=; DB=wings-system-db-dev; BANCO=${LOCAL_DB:?LOCAL_DB=<banco de teste>}; SEM_RD=1 ;;
  *) echo "ALVO inválido" >&2; exit 2 ;;
esac
[[ "$LIMITE_CHAVE" =~ ^[0-9]+$ ]] && [ "$LIMITE_CHAVE" -ge 2 ] || { echo "LIMITE_CHAVE deve ser um número >= 2" >&2; exit 2; }
[[ "$APAGAR_SUSPEITOS" =~ ^[01]$ ]] || { echo "APAGAR_SUSPEITOS deve ser 0 ou 1" >&2; exit 2; }
if [ "$MODO" = desfazer ] && ! [[ "$LOTE_DESFAZER" =~ ^limpeza-leads-[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo "LOTE deve ser como limpeza-leads-20261006T230000Z" >&2
  exit 2
fi
if [ "$MODO" = aplicar ] && [ "$ALVO" = staging ]; then
  echo "no staging esta limpeza só simula" >&2
  exit 2
fi

exec 9>/run/limpar-leads.lock
flock -n 9 || { echo "já existe uma limpeza rodando; espere ela terminar" >&2; exit 1; }

mkdir -p -m 700 "$LOGDIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$LOGDIR/$ALVO-$MODO-$STAMP.log"
: >"$LOG"
RD_IDS_TMP=$(mktemp)
trap 'rm -f "$RD_IDS_TMP"' EXIT

db_container=$(docker ps --format '{{.Names}}' | grep -- "$DB" | head -1 || true)
[ -n "$db_container" ] || { echo "contêiner do banco não encontrado" >&2; exit 1; }
api_container=
if [ -n "$API" ]; then
  api_container=$(docker ps --format '{{.Names}}' | grep -- "$API" | head -1 || true)
  [ -n "$api_container" ] || { echo "contêiner da API não encontrado" >&2; exit 1; }
fi

sql() { docker exec -i "$db_container" psql -X -q -U wings -d "$BANCO" -v ON_ERROR_STOP=1; }

# Deixa passar só as linhas de contagem (nunca ids, nomes, e-mails ou telefones).
so_contagens() {
  awk '
    /^(teste|repetidos|aviso:|feito:|cópia para desfazer|leads:|leads agora|lote:|PLANO:|APLICADO|SIMULAÇÃO|desfeito:)/ { print; next }
    /ERROR: / {
      if ($0 ~ /(revise|conferência|plano mudou|lote |dw\.dim_lead|nenhuma limpeza|chave primária)/) {
        sub(/.*ERROR: +/, "ERRO: "); print
      } else if ($0 ~ /lock timeout/) {
        print "ERRO: o banco estava ocupado com os leads (15 s de espera); rode de novo"
      } else {
        print "ERRO do banco (a mensagem está só no log)"
      }
      next
    }
  '
}

parametros="apagar_suspeitos=$APAGAR_SUSPEITOS limite_chave=$LIMITE_CHAVE rd=$([ "$SEM_RD" = 1 ] && echo nao || echo sim)"

# Cabeçalho do SQL: parâmetros e os ids dos negócios de teste lidos do RD.
cabecalho() {
  local lote=$1 esperado_apagar=${2:-} esperado_juntar=${3:-}
  echo "set limpeza.lote = '$lote';"
  echo "set limpeza.limite_chave = '$LIMITE_CHAVE';"
  echo "set limpeza.apagar_suspeitos = '$APAGAR_SUSPEITOS';"
  echo "set limpeza.esperado_apagar = '$esperado_apagar';"
  echo "set limpeza.esperado_juntar = '$esperado_juntar';"
  echo "set limpeza.rd_lido = '$([ -s "$RD_IDS_TMP" ] && echo 1 || echo 0)';"
  echo "create temp table rd_teste (rd_deal_id text primary key);"
  if [ -s "$RD_IDS_TMP" ]; then
    echo "insert into rd_teste values"
    sed "s/.*/('&')/" "$RD_IDS_TMP" | paste -sd, -
    echo "on conflict do nothing;"
  fi
}

fim() {
  if [ "$1" = gravar ]; then
    printf 'commit;\n\\echo APLICADO\n'
  else
    printf 'rollback;\n\\echo SIMULAÇÃO: nada foi gravado\n'
  fi
}

# Roda um arquivo SQL com o cabeçalho; devolve o código do psql.
rodar() {
  local arquivo=$1 final=$2
  shift 2
  set +e
  { cabecalho "$@"; cat "$AQUI/$arquivo"; fim "$final"; } | sql 2>&1 | tee -a "$LOG" | so_contagens
  local rc=${PIPESTATUS[1]}
  set -e
  return "$rc"
}

ler_rd() {
  if [ "$SEM_RD" = 1 ]; then
    if [ "$ALVO" = local ] && [ -n "${RD_IDS:-}" ]; then
      grep -E '^[A-Za-z0-9-]{1,64}$' "$RD_IDS" >"$RD_IDS_TMP" || true
      echo "negócios de teste no RD: $(wc -l <"$RD_IDS_TMP") (do arquivo de teste)"
      return
    fi
    echo "negócios de teste no RD: não lidos (SEM_RD=1); os testes saem só do banco"
    return
  fi
  echo "== Lendo no RD os nomes dos negócios (só leitura; cerca de 1 minuto)"
  local saida rc
  saida=$(mktemp)
  set +e
  docker exec -i "$api_container" node --input-type=module <"$AQUI/rd-testes.mjs" >"$saida" 2>>"$LOG"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ] || ! grep -q '^total [0-9]* de [0-9]*$' "$saida"; then
    rm -f "$saida"
    echo "Não consegui ler o RD (a mensagem está só no log: $LOG)." >&2
    echo "Rode de novo; ou, para achar os testes só pelo banco, rode com SEM_RD=1." >&2
    exit 1
  fi
  sed -n 's/^rd \([A-Za-z0-9-]\{1,64\}\)$/\1/p' "$saida" >"$RD_IDS_TMP"
  echo "negócios de teste no RD: $(sed -n 's/^total \([0-9]*\) de \([0-9]*\)$/\1 (de \2 negócios lidos)/p' "$saida")"
  rm -f "$saida"
}

pedir_producao() {
  if [ "$ALVO" != local ]; then
    [ -t 0 ] || { echo "isto precisa de um terminal interativo" >&2; exit 2; }
    [ -n "${TMUX:-}" ] || echo "AVISO: você não está dentro do tmux (se a conexão cair, nada fica pela metade: é uma transação só)."
  fi
  read -r -p "Digite PRODUCAO para continuar: " resposta
  [ "$resposta" = PRODUCAO ] || { echo "Cancelado. Nada foi gravado."; exit 1; }
}

echo "== Limpeza dos leads ($MODO) · alvo: $ALVO"
echo "   log completo (só o dono lê, permissão 600): $LOG"
echo "parâmetros: $parametros" | tee -a "$LOG"

if [ "$MODO" = desfazer ]; then
  echo
  echo "== Simulando o desfazer do lote $LOTE_DESFAZER"
  rodar desfazer.sql descartar "$LOTE_DESFAZER" || {
    echo "TERMINOU COM ERRO. Nada foi gravado. A mensagem está só no log: $LOG"
    exit 1
  }
  [ "$ALVO" = staging ] && exit 0
  echo
  echo "ATENÇÃO: isto GRAVA: devolve os leads e as linhas deste lote como eram."
  pedir_producao
  rodar desfazer.sql gravar "$LOTE_DESFAZER" || {
    echo "TERMINOU COM ERRO. Nada foi gravado (uma transação só). A mensagem está só no log: $LOG"
    exit 1
  }
  exit 0
fi

esperado_apagar=
esperado_juntar=
if [ "$MODO" = aplicar ]; then
  recente=$(find "$LOGDIR" -maxdepth 1 -name "$ALVO-simular-*.log" -mmin -1440 -print 2>/dev/null | sort | tail -1)
  if [ -z "$recente" ] || ! grep -q '^SIMULAÇÃO' "$recente" || ! grep -q '^PLANO: ' "$recente"; then
    echo "Falta uma simulação de menos de 24 h, terminada sem erro." >&2
    echo "Rode antes:  bash $0 simular" >&2
    exit 1
  fi
  if ! grep -qxF "parâmetros: $parametros" "$recente"; then
    echo "A última simulação usou outros parâmetros ($(grep -m1 '^parâmetros: ' "$recente" | cut -d' ' -f2-))." >&2
    echo "Simule de novo com os mesmos: bash $0 simular" >&2
    exit 1
  fi
  esperado_apagar=$(sed -n 's/^PLANO: apagar=\([0-9]*\) juntar=\([0-9]*\)$/\1/p' "$recente" | tail -1)
  esperado_juntar=$(sed -n 's/^PLANO: apagar=\([0-9]*\) juntar=\([0-9]*\)$/\2/p' "$recente" | tail -1)
  echo "   simulação conferida: $(basename "$recente")"
  echo "   ela previa: apagar $esperado_apagar lead(s) de teste e juntar $esperado_juntar repetido(s)"
  echo
  echo "ATENÇÃO: isto GRAVA na produção (apaga leads de teste e junta repetidos)."
  echo "O backup do banco já foi feito? Uma cópia deste lote fica no banco para desfazer."
  pedir_producao
fi

echo
ler_rd | tee -a "$LOG"
[ "${PIPESTATUS[0]}" -eq 0 ] || exit 1

LOTE="limpeza-leads-$STAMP"
echo
echo "== Rodando ($( [ "$MODO" = aplicar ] && echo 'grava ao fim' || echo 'tudo numa transação desfeita ao fim'))"
SECONDS=0
if ! rodar limpar.sql "$( [ "$MODO" = aplicar ] && echo gravar || echo descartar)" "$LOTE" "$esperado_apagar" "$esperado_juntar"; then
  echo
  echo "TERMINOU COM ERRO após $SECONDS s. Nada foi gravado (uma transação só). Mensagem completa no log: $LOG"
  exit 1
fi

if [ "$MODO" = aplicar ]; then
  echo
  echo "LOTE PARA DESFAZER: $LOTE"
  echo "Para desfazer só este lote (primeiro simula, depois pede PRODUCAO):"
  echo "  bash $0 desfazer $LOTE"
  echo "Para desfazer o lote do RD (rd-crm-20261006T1840Z), desfaça antes esta limpeza."
fi
echo
echo "Terminou em $SECONDS s. Log completo: $LOG"
