<img src="docs/icon.png" width="100" alt="Relaybase" />

# Relaybase Worker

Cloudflare Worker that powers [Relaybase](https://relaybase.xyz) product email — send, receive, inbox API, webhooks, and owner console routes. It runs entirely in **your** Cloudflare account. Relaybase does not host your mail.

This repository is the open-source routing Worker. The Relaybase desktop app is a separate commercial product that connects to a deployed instance of this Worker.

**Releases** (versioned `worker.X.Y.Z.js` + install ZIP):

| | URL |
|--|-----|
| Latest release | https://github.com/strum-us/relaybase-worker/releases/latest |
| Manifest | https://github.com/strum-us/relaybase-worker/releases/latest/download/worker-install-manifest.json |
| Worker JS (0.1.5) | https://github.com/strum-us/relaybase-worker/releases/download/v0.1.5/worker.0.1.5.js |
| Install ZIP (0.1.5) | https://github.com/strum-us/relaybase-worker/releases/download/v0.1.5/relaybase-worker-install-0.1.5.zip |

How to cut a release: [docs/RELEASE.md](./docs/RELEASE.md).

## What this Worker does

| Area | Routes | Auth |
|------|--------|------|
| Health / probes | `GET /health`, `GET /console/auth-status`, `GET /console/connect` | Public or owner |
| Owner setup & sessions | `POST /console/init-db`, `/console/migrate-db`, `/console/setup-admin`, `/console/login`, … | Pepper / OAuth / owner token |
| Management | `/console/*` (domains, keys, audience, broadcasts, branding, settings) | Owner console token |
| Mail UI API | `/mail/*` (inbox, sent, compose, search, favicon) | Owner mail token |
| Mobile companion | `/mobile/*` | Per-account mobile password |
| Integrations | `/v1/send`, `/v1/inbox/*`, `/v1/webhooks` | Domain-scoped API key |

Account, license, and billing live on `console.relaybase.xyz` — not on this Worker.

## Architecture

```
Your backend ──Bearer API key──▶ Relaybase Worker (Hono on Cloudflare)
                                        │
                    ┌───────────────────┼───────────────────┐
                    ▼                   ▼                   ▼
            CF Email Sending      D1 (catalog + index)    R2 mailbox
            (outbound)            RELAYBASE_DB/MAIL/LOGS  inbound + sent

Inbound: Sender ──MX──▶ CF Email Routing ──email()──▶ Worker ──▶ R2 + D1
```

**Storage (no KV):**

| Binding | Resource | Purpose |
|---------|----------|---------|
| `RELAYBASE_DB` | D1 `relaybase-db` | Domains, addresses, API keys, owner auth, audience, broadcasts, webhooks |
| `RELAYBASE_MAIL` | D1 `relaybase-mail` | Mail list, counts, FTS search (rebuildable from R2) |
| `RELAYBASE_LOGS` | D1 `relaybase-logs` | Ops event log (compose/API/broadcast sends, bounces) |
| `INBOUND` | R2 `relaybase-mailbox` | Mail atoms: `inbound\|sent {domain}/{id}/` (`meta.json` + `raw.eml`) |

## Prerequisites

- Node.js 22+
- A Cloudflare account with **Email Sending** and **Email Routing** enabled
- Workers Paid plan (~$5/mo billed by Cloudflare) for outbound send

## Quick start (local dev)

```bash
corepack enable
pnpm install

cp .dev.vars.example .dev.vars
# Set AUTH_PEPPER and CF_API_TOKEN (CF_ACCOUNT_ID is optional)

# Create storage in your account, then paste D1 ids into wrangler.toml
npx wrangler r2 bucket create relaybase-mailbox
npx wrangler d1 create relaybase-logs
npx wrangler d1 create relaybase-mail
npx wrangler d1 create relaybase-db

pnpm run dev    # http://127.0.0.1:8787
```

Set secrets:

```bash
npx wrangler secret put AUTH_PEPPER
npx wrangler secret put CF_API_TOKEN
```

Deploy:

```bash
pnpm run deploy
```

Initialize an empty D1 (first install only):

```bash
curl -X POST "$WORKER_URL/console/init-db" \
  -H "X-Auth-Pepper: $AUTH_PEPPER" \
  -H "Content-Type: application/json" \
  -d '{}'
```

On an existing install, apply pending migrations only:

```bash
curl -X POST "$WORKER_URL/console/migrate-db" \
  -H "Authorization: Bearer $OWNER_CONSOLE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Connect the [Relaybase desktop app](https://relaybase.xyz): paste your Worker URL → the Worker issues an owner passtoken once. The desktop can also auto-install from the GitHub Release ZIP above.

## Scripts

| Script | Purpose |
|--------|---------|
| `pnpm run dev` | `wrangler dev` |
| `pnpm run deploy` | Deploy to your Cloudflare account |
| `pnpm run build:bundle` | Bundle to `dist/worker-build/` (customer install ZIP) |
| `pnpm run typecheck` | TypeScript check |
| `pnpm test` | Unit tests |
| `pnpm run pack:customer-install` | Build versioned install ZIP under `dist/` |
| `pnpm run publish:github` | Pack and upload a GitHub Release (`v{version}`) |

## Environment

### Wrangler secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `AUTH_PEPPER` | Yes | Random pepper for owner passtoken hashing and access-token HMAC |
| `CF_API_TOKEN` | Yes (for DNS/domains) | Zone read + DNS edit + Email Routing rules |
| `CF_ACCOUNT_ID` | No | Pinned account id; optional — see Relaybase docs on CF OAuth install |

### Vars (`wrangler.toml`)

| Var | Description |
|-----|-------------|
| `WORKER_SCRIPT_NAME` | Worker script name (default `relaybase-api`) |
| `INBOUND_BUCKET_NAME` | R2 bucket label |
| `WORKER_VERSION` | Reported in `/health` |

## API examples

### Health

```bash
curl "$WORKER_URL/health"
```

### Issue API key (owner console token)

```bash
curl -X POST "$WORKER_URL/console/keys" \
  -H "Authorization: Bearer $OWNER_CONSOLE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"domain":"yourdomain.com","label":"billing-service"}'
```

### Send (`/v1/send`)

```bash
curl -X POST "$WORKER_URL/v1/send" \
  -H "Authorization: Bearer $RELAYBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "billing@yourdomain.com",
    "to": "customer@example.com",
    "subject": "Invoice #1234",
    "text": "Your invoice is ready."
  }'
```

## Security

- Never commit `.dev.vars` or real tokens.
- Issue one API key per service/domain pair; rotate by re-issuing.
- Owner passtoken is for the desktop owner only — use domain API keys for app integrations.
- Webhook secrets are shown once at registration; verify `X-Relaybase-Signature` in production.

## Relationship to Relaybase desktop

| Component | Repository | License |
|-----------|------------|---------|
| **This Worker** | `relaybase-worker` (this repo) | MIT — see [LICENSE](./LICENSE) |
| Desktop app + inbox UI | Private `relaybase` monorepo | Commercial |

The Worker is the trust layer: you deploy and audit it in your own account. The desktop app provides Spark-style inbox UX, one-click install, and license management.

## Development

```
relaybase-worker/
├── src/                 # Hono app, routes, lib
├── db/                  # Drizzle schemas + D1 migrations (app, mail, log)
├── scripts/             # Pack install ZIP, GitHub release
├── wrangler.toml        # Your deploy config (fill D1 ids)
└── wrangler.bundle.toml # Build-only config for the install ZIP
```

After changing routes or D1 helpers:

```bash
pnpm run build:bundle
```

Ship a new public script with `pnpm run publish:github`.

## License

MIT. See [LICENSE](./LICENSE).
