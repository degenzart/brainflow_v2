#!/usr/bin/env bash
set -euo pipefail

# Bash-only smoke tests for translation-worker.
# Default: local dev worker. Override with:
#   WORKER_URL="https://<your-worker>.workers.dev/translateBatch" ./tools/worker_smoke_tests.sh
WORKER_URL="${WORKER_URL:-http://127.0.0.1:8788/translateBatch}"

fail=0

run_test () {
  local name="$1"
  local payload="$2"
  local no_interrogative="${3:-}"

  echo "============================================================"
  echo "TEST: $name"
  echo "URL : $WORKER_URL"
  echo "------------------------------------------------------------"

  resp="$(curl -sS -X POST "$WORKER_URL" \
    -H "Content-Type: application/json" \
    -H "x-debug: 1" \
    -H "x-bypass-cache: 1" \
    --data-binary "$payload" || true)"

  echo "$resp"
  echo "------------------------------------------------------------"

  if ! echo "$resp" | grep -q '"issue":[[:space:]]*null'; then
    echo "RESULT: FAIL (issue not null)"
    fail=1
  elif [ "$no_interrogative" = "no_english_interrogative" ]; then
    if echo "$resp" | grep -qEi '\b(Which|What|Who|Where|When|How)\b'; then
      echo "RESULT: FAIL (translated question contains English interrogative)"
      fail=1
    else
      echo "RESULT: PASS"
    fi
  else
    echo "RESULT: PASS"
  fi
  echo
}

# 1) OK Computer / Oasis - protect band names, no mixed answers, no mutations
run_test "OK Computer / Oasis (must be clean)" \
'{
  "target": "de",
  "source": "en",
  "texts": [
    "Which band recorded the album OK Computer?",
    "Radiohead",
    "Muse",
    "Coldplay",
    "Oasis"
  ]
}'

# 2) Geography simple nouns - answers must not become questions
run_test "Italy/Europe/Germany/Austria (no stray question marks)" \
'{
  "target": "de",
  "source": "en",
  "texts": [
    "Italy",
    "Europe",
    "Germany",
    "Austria"
  ]
}'

# 3) Overwatch Lucio - MUST NOT create broken partial translation like “Welcher Held von Which…”
run_test "Overwatch Lúcio (no partial-source fragments)" \
'{
  "target":"de",
  "source":"en",
  "texts":[
    "Which Overwatch hero is from Brazil?",
    "Lúcio",
    "McCree",
    "Sombra",
    "Symmetra"
  ]
}' \
no_english_interrogative

# 4) Hocus Pocus 1973 - should be clean and stable
run_test "Hocus Pocus 1973 (clean)" \
'{
  "target":"de",
  "source":"en",
  "texts":[
    "Who had a hit with Hocus Pocus in 1973?",
    "Focus",
    "Pilot",
    "ELO",
    "Yes"
  ]
}'

echo "============================================================"
if [ "$fail" -eq 0 ]; then
  echo "ALL TESTS PASSED ✅"
  exit 0
else
  echo "SOME TESTS FAILED ❌"
  exit 1
fi
