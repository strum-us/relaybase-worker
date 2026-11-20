<img src="docs/icon.png" width="100" alt="Relaybase" />

# Relaybase Worker

https://github.com/user-attachments/assets/a9b6a926-6b8b-4930-9cdb-356479bb041d

[Download Relaybase](https://relaybase.email/download)

Cloudflare Worker that powers [Relaybase](https://relaybase.xyz) product email — send, receive, inbox API, webhooks, and owner console routes. It runs entirely in **your** Cloudflare account. Relaybase does not host your mail.

This repository is the open-source routing Worker. The Relaybase desktop app is a separate commercial product that connects to a deployed instance of this Worker.

**Current release: 0.1.13** (pairs with Relaybase app **0.2.0** / Desktop Launcher **1.0.0**). Release notes: [release-notes/0.1.13.md](./release-notes/0.1.13.md).

**Downloads** (versioned `worker.X.Y.Z.js` + install ZIP):

| | URL |
|--|-----|
| Latest release | https://github.com/strum-us/relaybase-worker/releases/latest |
| Manifest (R2) | https://downloads.relaybase.email/worker-install-manifest.json |
| Manifest (GitHub) | https://github.com/strum-us/relaybase-worker/releases/latest/download/worker-install-manifest.json |
| Worker JS (0.1.13) | https://downloads.relaybase.email/v0.1.13/worker.0.1.13.js |
| Install ZIP (0.1.13) | https://downloads.relaybase.email/v0.1.13/relaybase-worker-install-0.1.13.zip |

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

After you upload a new Worker script, Cloudflare Email Routing can keep rules
`enabled: true` but stop delivering to the Worker (Activity Log: **Delivery
failed**, no inbox row). This Worker re-PUTs worker-action rules on a
**15-minute cron** and via owner console repair routes
(`POST /console/domains/routing/repair`, `POST /console/domains/routing/repair-all`).

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
# Set AUTH_PEPPER (and RELAYBASE_DEV=1 so the Worker never redeploys itself from local dev)

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
```

There is no Cloudflare API token. The Worker calls the Cloudflare API (domains, DNS, Email
Routing, Email Sending, its own self-update) with the **Cloudflare OAuth grant** it keeps: the
Relaybase app hands it over at install, and **Settings › Cloudflare › Reconnect** hands a new one
over. A Worker deployed with wrangler gets one by running the app's update once
(Settings › Worker), which adds `CF_GRANT_KEY`, `CF_OAUTH_CLIENT_ID`, `RELEASE_ORIGIN` and hands
the grant over. See [Self-update](#self-update).

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
| `pnpm run release:key` | Create the release signing key (`~/.relaybase/release-signing-key.pem`) and add its public half to `src/lib/update/release-keys.json` |
| `pnpm run pack:release` | Build the signed self-update release into `dist/release/production/` |
| `pnpm run publish:release` | …and upload it to `downloads.relaybase.email/release/` |
| `pnpm run publish:release:staging` | Same for the staging channel (`/release-staging/`) |

## Environment

### Wrangler secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `AUTH_PEPPER` | Yes | Random pepper for owner passtoken hashing and access-token HMAC |
| `CF_GRANT_KEY` | Installer | AES-GCM key (base64, 32 bytes) for the stored Cloudflare OAuth refresh token. Never rotate it: a new key cannot read the stored grant |
| `RELAYBASE_HANDOFF` | Installer | SHA-256 of the one-time setup code that guards `/install/handoff` |

### Vars (`wrangler.toml`)

| Var | Description |
|-----|-------------|
| `WORKER_SCRIPT_NAME` | Worker script name (default `relaybase-api`) |
| `INBOUND_BUCKET_NAME` | R2 bucket label |
| `WORKER_VERSION` | Reported in `/health` |
| `APP_VERSION` | Relaybase app (client `app/`) version this Worker build ships with; reported in `/health` as `appVersion`. |

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

## Self-update

Same model as [Dotnote](https://github.com/strum-us/dotnote/blob/main/docs/self-update.md). The
Worker replaces its own script with the newest **signed** release from `RELEASE_ORIGIN`
(`https://downloads.relaybase.email/release`), using an access token minted from its Cloudflare
OAuth grant (`cf_grant` in `RELAYBASE_DB`, refresh token encrypted with `CF_GRANT_KEY`). Nobody
signs in to Cloudflare again for an update.

- **Release:** `pnpm run publish:release` packs `worker.js`, the embedded D1 migrations and the
  release notes into `manifest.json`, signs it (Ed25519, `manifest.json.sig`) and uploads it plus
  `archive/<version>/`. Workers trust only keys in `src/lib/update/release-keys.json`, then the
  bundle's SHA-256 from the signed manifest. Release notes front matter: `rollout: 25` (percent of
  installs offered the release) and `auto: false` (owners start it themselves).
- **Job:** `update_jobs` in `RELAYBASE_DB`, steps `prepare → migrate → deploy → verify`, one step
  per request (`POST /console/update/step`, owner session) or per cron run. `migrate` applies the
  release's migrations through the `d1_migrations` ledger before the new code goes up (they must
  only add). `deploy` re-PUTs the script with its current bindings, `keep_bindings` for secrets,
  and the update Cron Trigger. `verify` passes only when the new code answers.
- **Automatic updates:** the `*/30 * * * *` Cron Trigger (`src/lib/update/schedule.ts`) drives a
  running job and, unless the owner turned it off (`POST /console/update/auto`), starts one for a
  newer release that is not held by its rollout, not `auto: false`, and not tried before.
- **Routes:** `GET /console/update/check`, `/status`; `POST /start`, `/step`, `/retry`, `/cancel`,
  `/rollback`, `/auto`. `GET /console/cloudflare` (grant status), `POST /console/cloudflare/reconnect-code`.
  `POST /install/prove`, `/install/handoff` (setup or reconnect code; no session).
