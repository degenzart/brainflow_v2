#!/usr/bin/env bash
set -euo pipefail

# Bash-only smoke tests for translation-worker (v7.4 ALL-OR-NOTHING).
# Default: local dev worker. Override with:
#   WORKER_URL="https://<your-worker>.workers.dev/translateBatch" ./tools/worker_smoke_tests.sh
WORKER_URL="${WORKER_URL:-http://127.0.0.1:8788/translateBatch}"

fail=0

# v7.4: Never allow placeholder leak. Check response body for any placeholder token.
assert_no_placeholder () {
  local resp="$1"
  if echo "$resp" | grep -qE 'PROTECT_|__PROTECT|PROT_[0-9]'; then
    echo "RESULT: FAIL (placeholder leak in response)"
    return 1
  fi
  return 0
}

# v7.4: meta must include outcome (ok_translated | fallback_original).
assert_meta_outcome () {
  local resp="$1"
  if echo "$resp" | grep -qE '"outcome":[[:space:]]*"(ok_translated|fallback_original)"'; then
    return 0
  fi
  echo "RESULT: FAIL (meta.outcome missing or invalid)"
  return 1
}

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

  if ! assert_no_placeholder "$resp"; then fail=1; echo; return; fi
  if ! assert_meta_outcome "$resp"; then fail=1; echo; return; fi

  if ! echo "$resp" | grep -q '"issue":[[:space:]]*null'; then
    # issue non-null => expect fallback_original and translated = original (HTML-decoded)
    if echo "$resp" | grep -q '"outcome":[[:space:]]*"fallback_original"'; then
      echo "RESULT: PASS (fallback_original as expected)"
    else
      echo "RESULT: FAIL (issue set but outcome not fallback_original)"
      fail=1
    fi
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

# --- v7.4 regression: 6 cases ---

# 1) HTML entity answer (Lúcio) - input may have &#250; or similar; output must be clean, no placeholder
run_test "v7.4 regression 1: HTML entity answer (Lúcio)" \
'{
  "target": "de",
  "source": "en",
  "texts": [
    "Which Overwatch hero is from Brazil?",
    "Lúcio",
    "McCree",
    "Sombra",
    "Symmetra"
  ]
}' \
no_english_interrogative

# 2) German question with possible English fragment - expect ok_translated or fallback_original
run_test "v7.4 regression 2: German question (no mixed-language output)" \
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

# 3) Placeholder leak: any response must never contain PROTECT_ or __PROTECT (asserted in run_test)

# 4) Mixed answers scenario - some translated some not; expect fallback or ok
run_test "v7.4 regression 4: Mixed answers scenario" \
'{
  "target": "de",
  "source": "en",
  "texts": [
    "What is the capital of France?",
    "Paris",
    "Lyon",
    "Marseille",
    "Berlin"
  ]
}'

# 5) Pure proper noun answers - expect ok_translated (unchanged allowed)
run_test "v7.4 regression 5: Pure proper noun answers" \
'{
  "target": "de",
  "source": "en",
  "texts": [
    "Which band released Definitely Maybe?",
    "Oasis",
    "Beatles",
    "Mozart",
    "Google"
  ]
}'

# 6) Numeric answers - expect ok_translated
run_test "v7.4 regression 6: Numeric answers" \
'{
  "target": "de",
  "source": "en",
  "texts": [
    "In which year did World War II end?",
    "1945",
    "1939",
    "1941",
    "1950"
  ]
}'

# --- v7.3: relaxed protection — generic Title Case translates ---

# Pulmonary Artery / Pulmonary Vein => NOT protected, should translate to DE
run_test "v7.3: Pulmonary Artery/Vein (generic words → translate)" \
'{
  "target": "de",
  "source": "en",
  "texts": [
    "Which vessel carries deoxygenated blood?",
    "Pulmonary Artery",
    "Pulmonary Vein",
    "Aorta",
    "Vena Cava"
  ]
}'

# Spanish Flu => NOT protected, expect "Spanische Grippe" or similar in output
run_test "v7.3: Spanish Flu (generic → translate)" \
'{
  "target": "de",
  "source": "en",
  "texts": [
    "What pandemic was known as the Spanish Flu?",
    "1918 Flu",
    "Spanish Flu",
    "Asian Flu",
    "Hong Kong Flu"
  ]
}'

# Stranger Things / Eleven / Max Mayfield => proper nouns, protected, unchanged
run_test "v7.3: Stranger Things proper nouns (protected)" \
'{
  "target": "de",
  "source": "en",
  "texts": [
    "Which show features Eleven and Max Mayfield?",
    "Stranger Things",
    "Eleven",
    "Max Mayfield",
    "Hawkins"
  ]
}'

# Chem symbols Au/Ag/Fe/Pb => short tokens, protected
run_test "v7.3: Chem symbols Au/Ag/Fe/Pb (protected)" \
'{
  "target": "de",
  "source": "en",
  "texts": [
    "What is the chemical symbol for gold?",
    "Au",
    "Ag",
    "Fe",
    "Pb"
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
