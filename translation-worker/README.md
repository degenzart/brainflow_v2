## Cloudflare Translation Worker

Provides:
- `POST /translateBatch`
- Sends all texts in one Google Translate call (batch)
- Optional KV cache to reduce Google costs
- Optional client auth via `X-Client-Key`

### API

Request JSON:

```json
{
  "target": "es",
  "source": "auto",
  "texts": ["Question text", "Answer 1", "Answer 2", "Answer 3", "Answer 4"]
}
```

Response JSON:

```json
{
  "translated": ["...", "...", "...", "...", "..."]
}
```

Validation:
- `target`: 2..5 characters (e.g. `es`, `de`, `pt`)
- `texts`: array of 1..20 items
- each text max 400 chars (MVP)

Errors:
- `400` for validation errors: `{ "error": "..." }`
- `500` for server errors: `{ "error": "..." }`

### Secrets

From `translation-worker/`:

```bash
wrangler secret put GOOGLE_API_KEY
wrangler secret put CLIENT_KEY
```

### KV (optional, recommended)

Create a KV namespace:

```bash
wrangler kv namespace create TRANSLATION_CACHE
```

Put the created `id` into `wrangler.toml` under `kv_namespaces`.

### Run locally

From `translation-worker/`:

```bash
wrangler dev
```

Test:

```bash
curl -X POST http://localhost:8787/translateBatch \
  -H 'Content-Type: application/json' \
  -H 'X-Client-Key: YOUR_CLIENT_KEY' \
  --data '{"target":"es","source":"auto","texts":["Hello","World"]}'
```

### Test Cases (Acronyms / Names / “Stand for” mixed mode)

All test cases below are designed to be **copy-paste runnable** against `wrangler dev`.

- If your local port differs, replace `http://localhost:8787`.
- Add `-H 'X-Client-Key: ...'` only if you set `CLIENT_KEY`.
- Use `-H 'x-debug: 1'` to get an extra response field `mode: "full" | "skip" | "mixed"`.

#### 1) Mixed-mode EN→DE (dotted acronym): T.A.R.D.I.S.

```bash
curl -sS -X POST http://localhost:8787/translateBatch \
  -H 'Content-Type: application/json' \
  -H 'x-debug: 1' \
  --data '{"target":"de","source":"auto","texts":["What does T.A.R.D.I.S. stand for?","Time and Relative Dimension in Space","Totally Awesome Robot Doing Interesting Stuff"]}'
```

- **Expected**: `mode=mixed`
- **Expected**: `translated[0]` starts with **"Wofür steht"** and contains **"T.A.R.D.I.S."** unchanged
- **Expected**: `translated[1..]` exactly equals the input answers (no translation)
- **Why**: verifies mixed-mode trigger (stand-for + acronym) and no answer translation.

#### 2) Mixed-mode DE→EN (dotted acronym): T.A.R.D.I.S.

```bash
curl -sS -X POST http://localhost:8787/translateBatch \
  -H 'Content-Type: application/json' \
  -H 'x-debug: 1' \
  --data '{"target":"en","source":"auto","texts":["Wofür steht T.A.R.D.I.S.?","Time And Relative Dimension In Space","Irgendeine falsche Antwort"]}'
```

- **Expected**: `mode=mixed`
- **Expected**: `translated[0]` starts with **"What does"** and contains **"T.A.R.D.I.S."** unchanged
- **Expected**: answers unchanged
- **Why**: validates reverse direction and that the acronym is still protected.

#### 3) Mixed-mode with block acronym: NASA (EN→DE)

```bash
curl -sS -X POST http://localhost:8787/translateBatch \
  -H 'Content-Type: application/json' \
  -H 'x-debug: 1' \
  --data '{"target":"de","source":"auto","texts":["What does NASA stand for?","National Aeronautics and Space Administration","Not A Space Agency"]}'
```

- **Expected**: `mode=mixed`
- **Expected**: `translated[0]` starts with **"Wofür steht"**, contains **"NASA"** unchanged
- **Expected**: answers unchanged
- **Why**: ensures mixed-mode also triggers for block acronyms.

#### 4) Skip-mode: only acronyms + punctuation (no useful translatable content)

```bash
curl -sS -X POST http://localhost:8787/translateBatch \
  -H 'Content-Type: application/json' \
  -H 'x-debug: 1' \
  --data '{"target":"de","source":"auto","texts":["NASA?!","FBI.","DNA:"]}'
```

- **Expected**: `mode=skip`
- **Expected**: `translated` equals input exactly
- **Why**: cost brake: don’t pay Google when there’s nothing meaningful to translate.

#### 5) Full-mode: normal knowledge question without acronyms (EN→DE)

```bash
curl -sS -X POST http://localhost:8787/translateBatch \
  -H 'Content-Type: application/json' \
  -H 'x-debug: 1' \
  --data '{"target":"de","source":"auto","texts":["Which planet is known as the Red Planet?","Mars","Jupiter","Saturn","Venus"]}'
```

- **Expected**: `mode=full`
- **Expected**: outputs generally differ from input (German translation), array length unchanged
- **Why**: baseline sanity check for normal batch translation.

#### 6) Placeholder name protection: person name sequence (EN→DE)

```bash
curl -sS -X POST http://localhost:8787/translateBatch \
  -H 'Content-Type: application/json' \
  -H 'x-debug: 1' \
  --data '{"target":"de","source":"auto","texts":["Which singer is known as Michael Jackson?","Michael Jackson","Elvis Presley","Madonna","Freddie Mercury"]}'
```

- **Expected**: `mode=full`
- **Expected**: **"Michael Jackson"** remains exactly **"Michael Jackson"** wherever it appears
- **Why**: protects high-risk proper names from being altered by translation.

#### 7) Placeholder name protection: place name sequence (EN→DE)

```bash
curl -sS -X POST http://localhost:8787/translateBatch \
  -H 'Content-Type: application/json' \
  -H 'x-debug: 1' \
  --data '{"target":"de","source":"auto","texts":["Where is New York City located?","New York City is in the United States.","It is in Germany."]}'
```

- **Expected**: `mode=full`
- **Expected**: **"New York City"** remains exactly **"New York City"**
- **Why**: protects multi-word place names from being translated/rewritten.

#### 8) Placeholder + full translate combined (acronym protected, but not mixed)

```bash
curl -sS -X POST http://localhost:8787/translateBatch \
  -H 'Content-Type: application/json' \
  -H 'x-debug: 1' \
  --data '{"target":"de","source":"auto","texts":["In Doctor Who, the T.A.R.D.I.S. travels through time.","True","False"]}'
```

- **Expected**: `mode=full`
- **Expected**: **"T.A.R.D.I.S."** remains unchanged
- **Expected**: NOT mixed (no “stand for” pattern)
- **Why**: ensures acronyms are protected even in normal translation flow.

#### 9) Mixed-mode to another target language (EN→ES)

```bash
curl -sS -X POST http://localhost:8787/translateBatch \
  -H 'Content-Type: application/json' \
  -H 'x-debug: 1' \
  --data '{"target":"es","source":"auto","texts":["What does T.A.R.D.I.S. stand for?","Time And Relative Dimension In Space","Totally Accurate Random Data In Storage"]}'
```

- **Expected**: `mode=mixed`
- **Expected**: `translated[0]` is a Spanish template (may vary), but contains **"T.A.R.D.I.S."** unchanged
- **Expected**: answers unchanged
- **Why**: validates “1 mini-call” behavior for non-DE/EN mixed-mode.

#### 10) Edge case: “stand for” without a clear acronym (false-positive control)

```bash
curl -sS -X POST http://localhost:8787/translateBatch \
  -H 'Content-Type: application/json' \
  -H 'x-debug: 1' \
  --data '{"target":"de","source":"auto","texts":["What does it stand for?","Option A","Option B"]}'
```

- **Expected**: `mode=full` (NOT mixed) because no acronym is present
- **Why**: prevents accidental mixed-mode triggers that would reduce translation quality.

#### 11) Unit conversion (miles -> km) postprocess (DE)

```bash
curl -sS -X POST http://localhost:8787/translateBatch \
  -H 'Content-Type: application/json' \
  -H 'x-debug: 1' \
  --data '{"target":"de","source":"en","texts":["How long is a marathon?","26.2 miles","5 mi"]}'
```

- **Expected**: `unitFixApplied=true`, `unitFixHits>=2`
- **Expected** (answers postprocess):
  - `"26.2 miles"` -> `"26,2 Meilen (42,2 km)"`
  - `"5 mi"` -> `"5 Meilen (8,0 km)"`

#### 12) Unit conversion is skipped for EN target

```bash
curl -sS -X POST http://localhost:8787/translateBatch \
  -H 'Content-Type: application/json' \
  -H 'x-debug: 1' \
  --data '{"target":"en","source":"de","texts":["How long is a marathon?","42.2 km","5km"]}'
```

- **Expected**: `unitFixMode="km_to_mi"`, `unitFixApplied=true`, `unitFixHits>=2`
- **Expected** (answers postprocess):
  - `"42.2 km"` -> `"26.2 miles (42.2 km)"` (approx, rounding to 1 decimal)
  - `"5km"` -> `"3.1 miles (5.0 km)"`

#### 13) Symmetry guard: no double conversion

```bash
curl -sS -X POST http://localhost:8787/translateBatch \
  -H 'Content-Type: application/json' \
  -H 'x-debug: 1' \
  --data '{"target":"en","source":"de","texts":["Test","26.2 miles","42.2 km"]}'
```

- **Expected**: for `target=en` only `km` gets converted; `"26.2 miles"` stays as-is.

