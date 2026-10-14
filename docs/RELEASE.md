# Worker install release workflow

Customer-facing Worker installs ship as **pre-built JS bundles** (not TypeScript source).

**Start with the full checklist:** sibling repo [client/docs/release/workflow.md](../../client/docs/release/workflow.md).

Version pairing policy: [client/docs/release/version-sync.md](../../client/docs/release/version-sync.md).

Patch-only channel after **0.1.1** (`0.1.2`, `0.1.3`, …). No separate dev / `+local` channel.

---

## Git workflow

Every Worker release uses a dedicated branch. Do **not** bump versions or
commit download artifacts straight on `main`.

```text
release-worker-<semver>    # e.g. release-worker-0.1.3
```

1. `git checkout main && git pull`
2. `git checkout -b release-worker-X.Y.Z`
3. All release work on that branch (version, notes, README links)
4. Push branch → PR → merge into `main`
5. **`pnpm run publish:github`** — uploads the install bundle to R2 (`downloads.relaybase.email`) and creates tag `vX.Y.Z` plus GitHub Release assets
6. Keep `release-worker-X.Y.Z` on the remote

**Do not stop after `pack:customer-install`.** The app reads the R2 manifest, and falls back to the GitHub Release copy. Without `publish:github`, Settings → Worker version stays on the previous release.

One-time, on the Relaybase Cloudflare account:

```bash
export CLOUDFLARE_API_TOKEN='...'   # R2 edit + DNS edit on relaybase.email
export CLOUDFLARE_ACCOUNT_ID='3adf03d991843094a7343eebc0a98007'
pnpm run setup:downloads
```

The same token is required for `publish:github` and as the `CLOUDFLARE_API_TOKEN` Actions secret.

Browsers fetch the manifest and ZIP cross-origin, so every app origin must be listed in
[`downloads-cors.json`](../downloads-cors.json): the web app, staging, local dev, and the
desktop launcher (`http://localhost:32838` release; `tauri dev` uses `http://localhost:32830`;
see `client/docs/desktop/tauri.md`). Re-run `pnpm run setup:downloads` after editing it —
the bucket keeps the old rules until then.

---

## Checklist

### 1. Version bump

Set the version in [`package.json`](../package.json) and `wrangler.toml` → `WORKER_VERSION`.
Also set `wrangler.toml` → `DESKTOP_VERSION` to the desktop app version this
Worker build is compatible with (mirrors `WORKER_VERSION`'s upkeep; reported
in `/health` as `desktopVersion` and read back by the pack script below).

When web client also ships, bump version in sibling `client/` and note pairing in release notes.

### 2. Release notes (required)

Create `release-notes/X.Y.Z.md`:

```markdown
---
date: YYYY-MM-DD
---

# Relaybase Worker X.Y.Z

## Highlights
- …

## Changes
- …
```

`pack-customer-install.mjs` **fails** if this file is missing.

### 3. Publish R2 + GitHub Release

From this repo (requires `gh` auth and `CLOUDFLARE_API_TOKEN`):

```bash
pnpm run publish:github
```

This runs `pack:customer-install` with zip URLs on `https://downloads.relaybase.email`, uploads those objects to the `relaybase-downloads` bucket, then creates/updates release `vX.Y.Z` with the same files:

- `worker.X.Y.Z.js`
- `relaybase-worker-install-X.Y.Z.zip`
- `relaybase-worker-install.zip` (latest alias, GitHub only; R2 latest alias is `relaybase-worker-install.zip` at the bucket root)
- `worker-install-manifest.json`

Pushing a `v*` tag also runs `.github/workflows/release.yml` (needs the `CLOUDFLARE_API_TOKEN` secret).

Local pack only (no upload; manifest URLs stay on GitHub unless `RELAYBASE_DOWNLOAD_BASE` is set):

```bash
pnpm run pack:customer-install
```

Output under `dist/` (gitignored). Use for smoke tests, not customer delivery.

### 4. Verify

```bash
curl -sL https://downloads.relaybase.email/worker-install-manifest.json | jq .version
curl -sL https://github.com/strum-us/relaybase-worker/releases/latest/download/worker-install-manifest.json | jq .version
curl -sI https://downloads.relaybase.email/vX.Y.Z/worker.X.Y.Z.js | grep -i HTTP
```

---

## What the pack script produces

| Output | Purpose |
|--------|---------|
| `worker.{version}.js` | Wrangler-bundled Worker (all deps inlined) |
| `worker.js` | Same bytes as `worker.{version}.js` (compat alias for 0.1.1 desktops) |
| `wrangler.toml` | Generated at pack time (`main = "worker.{version}.js"`) |
| `VERSION` | Plaintext version for staging |
| `worker-install-manifest.json` | `{ version, zipUrl, zipSha256, workerJs, workerJsUrl, publishedAt, notes }` |

Desktop auto-install and Worker updates download the R2 manifest (GitHub Release
manifest if R2 is unreachable), verify SHA-256, unzip, and upload the script — **no `npm install`**, no local overlay.

Public URLs (after publish):

| Asset | URL |
|-------|-----|
| Latest manifest (R2) | `https://downloads.relaybase.email/worker-install-manifest.json` |
| Versioned Worker JS (R2) | `https://downloads.relaybase.email/vX.Y.Z/worker.X.Y.Z.js` |
| Versioned install ZIP (R2) | `https://downloads.relaybase.email/vX.Y.Z/relaybase-worker-install-X.Y.Z.zip` |
| Latest manifest (GitHub) | `https://github.com/strum-us/relaybase-worker/releases/latest/download/worker-install-manifest.json` |
| Versioned install ZIP (GitHub) | `https://github.com/strum-us/relaybase-worker/releases/download/vX.Y.Z/relaybase-worker-install-X.Y.Z.zip` |

## Desktop behavior

- **Fresh install:** downloads latest ZIP from manifest → deploy → stores `workerVersion` in workspace config.
- **Settings → Worker version:** compares the installed version to the R2 manifest (GitHub copy if R2 is down); **Update Worker** redeploys.
- Update offered only when manifest version **>** installed Worker and **≤** desktop app version.

## Local overrides

| Env var | Effect |
|---------|--------|
| `RELAYBASE_INSTALL_MANIFEST_URL` | Override manifest URL for install (skips the R2 → GitHub fallback) |
| `RELAYBASE_DOWNLOAD_BASE` | Base URL written into `zipUrl` / `workerJsUrl` at pack time |
| `CLOUDFLARE_API_TOKEN` | Required by `publish:github` and `setup:downloads` |
