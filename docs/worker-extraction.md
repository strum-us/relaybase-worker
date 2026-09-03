# Worker extraction (completed)

This repo is the product Worker, extracted from the `relaybase` monorepo (`server/`).

**Layout:** clone as a sibling of `relaybase`:

```text
productions/
├── relaybase/           # desktop, app, mobile, HQ
└── relaybase-worker/    # this repo
```

Dogfood Wrangler IDs live in gitignored `wrangler.local.toml` (copied from the old monorepo `server/wrangler.toml`). Public `wrangler.toml` uses `REPLACE_WITH_*` placeholders.

## What the monorepo now does

| Root script | Delegates to |
|-------------|--------------|
| `npm run dev` | `../relaybase-worker` (`RELAYBASE_WORKER_DIR` override) |
| `npm run deploy` | same — uses `wrangler.local.toml` when present |
| `npm run typecheck` | same |
| `pnpm pack:worker-install` | `pack:customer-install` → writes `relaybase/hq/website/public/downloads/` |

Helper: `relaybase/scripts/run-worker.mjs`.

## Pack output

`scripts/pack-customer-install.mjs` resolves downloads as:

1. `RELAYBASE_DOWNLOADS_DIR` if set
2. Sibling `../relaybase/hq/website/public/downloads` if that tree exists
3. Else `dist/downloads/` in this repo

## Remaining notes

- Historical plans under `relaybase/.cursor/plans/` and `relaybase/docs/legacy/` still mention `server/` — leave them; they are not the live path.
- License text (`LICENSE`) is a draft Fair Source stub. Replace with final BSL/FSL before a public GitHub announcement.
- Do not commit `wrangler.local.toml` or `.dev.vars`.
