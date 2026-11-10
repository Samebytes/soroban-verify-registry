# soroban-verify-registry

`POST /verifications`, `GET /contracts/:id`, `GET /badge/:id.svg`. Testnet only. See
[openapi.yaml](openapi.yaml).

Requires Node 22.13+ (SQLite uses the built-in `node:sqlite`).

- **Storage:** SQLite (default) or Postgres (`DATABASE_URL`).
- **Auth and limits:** `API_KEYS` protects `POST`. Rate limiting is per valid API key, otherwise per
  client IP (unknown keys count against the IP).
- **Trust:** new entries are `self_reported`. With `REVERIFY=1` a worker rebuilds the commit with the
  `soroban-verify` CLI and stores the server's own result as `reverified`.

Needs the `stellar` CLI on PATH to check on-chain hashes (and `docker`, `git`, `soroban-verify` for the worker).

```
npm install && npm test && npm run lint
API_KEYS=changeme PORT=3000 DB_PATH=registry.db npm start
```

The server refuses to start without `API_KEYS` unless `ALLOW_ANONYMOUS=1`.

## Environment

| Variable | Meaning |
|---|---|
| `PORT` | Listen port (default 3000) |
| `DB_PATH` / `DATABASE_URL` | SQLite file / Postgres connection string |
| `API_KEYS` | Comma-separated keys for `POST /verifications` |
| `RATE_LIMIT`, `RATE_WINDOW_SECONDS` | Requests per window per valid key, else per IP (default 60 / 60; `0` disables) |
| `REVERIFY` | `1` runs the re-verification worker |

## Postgres tests

The storage suite also runs against Postgres when `PG_URL` is set:

```
docker run -d --rm -p 5433:5432 -e POSTGRES_PASSWORD=pw postgres:16-alpine
PG_URL=postgres://postgres:pw@localhost:5433/postgres npm test
```
