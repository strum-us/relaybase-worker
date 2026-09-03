# Relaybase Worker — install into your Cloudflare account

This package deploys the Relaybase routing Worker into **your** Cloudflare account. It is the same Worker code Relaybase runs for its own dogfood install; it only serves product routes (`/mail/*`, `/console/*`, `/mobile/*`, `/v1/*`). Account, billing, and license live in the separate `console.relaybase.xyz` Next.js app.

## Two ways to install

1. **Auto-install (recommended)** — from the Relaybase desktop app: authorize Cloudflare; the desktop deploys for you and the Worker issues an **owner passtoken** once. Copy or download that passtoken. Daily unlock uses the OS keyring.
2. **Manual install (this README)** — for advanced users or headless machines: run Wrangler yourself, then paste the Worker URL into the app. The app calls `setup-admin` and shows the passtoken once. Do **not** invent a login token or put one in wrangler secrets.

> Cloudflare may bill a small Workers Paid plan fee (≈$5/mo) directly to you. Relaybase Pro is a separate, one-time software license.

## Prerequisites (manual install)

- A Cloudflare account
- Node.js 20+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (`npx wrangler` is enough)

## 1. Create storage (exact names)

```bash
npx wrangler r2 bucket create relaybase-mailbox
npx wrangler d1 create relaybase-logs
npx wrangler d1 create relaybase-mail
npx wrangler d1 create relaybase-db
```

Copy each D1 **id** into `wrangler.toml` (replace the `REPLACE_WITH_*` placeholders). Do **not** create a KV namespace — product state is D1 + R2. Owner login is a Worker-issued **passtoken**, not a wrangler secret.

## 2. Set install secrets

`AUTH_PEPPER` is an internal hash pepper (install bootstrap). It is **not** your login password.

```bash
npx wrangler secret put AUTH_PEPPER
```

Use a long random value (e.g. `openssl rand -hex 32`). The desktop Manual install command generates this for you. After first owner setup, you do not type this value again.

For domain / inbox routing / DNS from the Worker, add `CF_API_TOKEN` as a **Secret** in the dashboard (Worker → Settings → Runtime variables and secrets) or:

```bash
npx wrangler secret put CF_API_TOKEN
```

`CF_ACCOUNT_ID` is optional. Desktop auto-install may set it. The Worker does not need it for mail or the Cloudflare API.

The token needs Zone → Email Routing Rules → Edit, Zone → Zone → Read, and Zone → DNS → Edit. Sending uses the `[[send_email]]` `EMAIL` binding in `wrangler.toml`, not this token.

Do **not** set `ADMIN_TOKEN`. That secret is retired.

## 3. Deploy

```bash
npx wrangler deploy
```

Wrangler prints a URL like `https://relaybase-api.<your-subdomain>.workers.dev`.

## 4. Initialize D1 schema

The Worker owns its own schema. After deploy, while no owner exists yet, call init-db with the same pepper:

```bash
curl -X POST https://relaybase-api.<your-subdomain>.workers.dev/console/init-db \
  -H "X-Auth-Pepper: <AUTH_PEPPER>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

`init-db` refuses existing product tables (HTTP 409 `DB_ALREADY_INITIALIZED`)
and never drops data, even with `{ "clear": true }`. On an existing install,
apply pending schema only (`migrate-db` accepts an owner session, Cloudflare
OAuth, or pepper while no owner exists):

```bash
curl -X POST https://relaybase-api.<your-subdomain>.workers.dev/console/migrate-db \
  -H "X-Auth-Pepper: <AUTH_PEPPER>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

To start empty, delete the D1 databases in Cloudflare, create new ones, bind
them, deploy, then call `init-db`. Do not use `clear: true`.

The desktop Manual flow runs this curl for you as part of the copied command.

## 5. Connect the desktop app

1. Open Relaybase → **Install routing Worker** → Manual
2. Paste the `*.workers.dev` URL that Wrangler printed
3. Tap **I'm done** — the Worker issues an owner passtoken (`rb_pass_…`) once
4. Copy or download the passtoken. This Mac also writes it to the OS keyring

Later logins use Touch ID to read the keyring, or you type the passtoken. Lost passtoken: **Setup → I forgot my passtoken** (Cloudflare OAuth), not a console email recovery.

## Worker endpoints this package exposes

- `GET /health` — liveness + R2 binding check (public)
- `GET /console/auth-status` — `{ ownerConfigured }` (public)
- `GET /console/connect` — desktop probe (owner console access)
- `POST /console/init-db` — initialize **empty** D1 only (pepper / OAuth / owner); existing data → 409
- `POST /console/migrate-db` — apply pending migrations only; never drops tables
- `POST /console/setup-admin` — first owner; issues passtoken once (`X-Auth-Pepper`)
- `POST /console/login` / `refresh` / `logout` — owner session
- `/console/*` — management (owner console access)
- `/mail/*` — desktop mail (owner mail access)
- `/mobile/*` — Flutter companion + desktop team-user login (per-account mobile password)
- `/v1/*` — domain-scoped send/inbox/webhooks (API-key auth)

Account, license, and billing are **not** on this Worker — they live at `console.relaybase.xyz`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Verify → unauthorized | Sign in with the owner passtoken (or unlock via keyring). Pepper is not a login token |
| Verify → not Relaybase | Wrong URL, or deploy failed — open `/health` in a browser |
| Deploy fails on D1 id | Paste real database ids into `wrangler.toml` |
| R2 not configured in `/health` | Ensure bucket `relaybase-mailbox` exists and is bound as `INBOUND` |
| Lost passtoken | Desktop → Setup → I forgot my passtoken (Cloudflare OAuth) |
