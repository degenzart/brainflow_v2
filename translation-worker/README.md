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
- `400` for validation errors: `{ "error": "... " }`
- `500` for server errors: `{ "error": "... " }`

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

### Regression tests

- **Proper nouns & country names**: Named entities (e.g. game titles, artists, country names) should stay stable and not be mistranslated.
- **German quality**: No obvious English fragments should remain in German questions; fallback or forced rewrites handle mixed language cases.
- **Glossary usage**: The Google Translation v3 glossary is only requested and applied for **EN→DE** traffic; other language pairs (e.g. EN→ES) must not try to use the EN-DE glossary and must not fail.

To run a small set of manual regression tests, you can use the helper script:

```bash
/tmp/bf_translate_regression.sh
```

The script exercises:
- EN→DE with glossary enabled,
- proper-noun protection (game characters, titles),
- EN→ES (must succeed, and should have `glossaryRequested=false` in the worker meta/logs).

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

