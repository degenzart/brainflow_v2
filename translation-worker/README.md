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

