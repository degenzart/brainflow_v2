#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CSV_PATH="${GLOSSARY_CSV:-$ROOT_DIR/translation-worker/glossary/brainflow_en_de_main.csv}"
SA_PATH="${GCP_SA_JSON_FILE:-$ROOT_DIR/.secrets/gcp_sa.json}"

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required (e.g. brainflow-translate)}"
export GLOSSARY_LOCATION="${GLOSSARY_LOCATION:-us-central1}"
export GLOSSARY_ID="${GLOSSARY_ID:-brainflow_en_de_main}"
export GLOSSARY_BUCKET="${GLOSSARY_BUCKET:-brainflow-translate-glossary}"
export GLOSSARY_CSV="$CSV_PATH"
export GCP_SA_JSON_FILE="$SA_PATH"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found" >&2
  exit 1
fi

if [ ! -f "$CSV_PATH" ]; then
  echo "ERROR: Glossary CSV not found: $CSV_PATH" >&2
  exit 1
fi

if [ ! -f "$SA_PATH" ]; then
  echo "ERROR: Service account JSON not found: $SA_PATH" >&2
  echo "Create it at: $SA_PATH" >&2
  exit 1
fi

python3 "$ROOT_DIR/scripts/deploy_glossary.py"
