# Worker install release workflow

Customer-facing Worker installs ship as **pre-built JS bundles** (not TypeScript source).

**Start with the full checklist:** sibling repo [main/docs/release/workflow.md](../main/docs/release/workflow.md).

Version pairing policy: [main/docs/release/version-sync.md](../main/docs/release/version-sync.md).

Desktop releases: [main/desktop/docs/release.md](../main/desktop/docs/release.md).

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
5. **`pnpm run publish:github`** — creates tag `vX.Y.Z` and GitHub Release assets
6. Keep `release-worker-X.Y.Z` on the remote

**Do not stop after `pack:customer-install`.** The desktop app reads the GitHub Release manifest. Without `publish:github`, Settings → Worker version stays on the previous release.

---

## Checklist

### 1. Version bump

Set the version in [`package.json`](../package.json) and `wrangler.toml` → `WORKER_VERSION`.

When desktop also ships, bump desktop in sibling `main/` and note pairing in desktop release notes.

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

### 3. Publish GitHub Release

From this repo (requires `gh` auth):

```bash
pnpm run publish:github
```

This runs `pack:customer-install`, then creates/updates release `vX.Y.Z` with:

- `worker.X.Y.Z.js`
- `relaybase-worker-install-X.Y.Z.zip`
- `relaybase-worker-install.zip` (latest alias)
- `worker-install-manifest.json`

Pushing a `v*` tag also runs `.github/workflows/release.yml`.

Local pack only (no GitHub):

```bash
pnpm run pack:customer-install
```

Output under `dist/` (gitignored). Use for smoke tests, not customer delivery.

### 4. Verify

```bash
curl -sL https://github.com/strum-us/relaybase-worker/releases/latest/download/worker-install-manifest.json | jq .version
curl -sI https://github.com/strum-us/relaybase-worker/releases/download/vX.Y.Z/worker.X.Y.Z.js | grep -i HTTP
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

Desktop auto-install and Worker updates download the GitHub Release manifest,
verify SHA-256, unzip, and upload the script — **no `npm install`**, no local overlay.

Public URLs (after publish):

| Asset | URL |
|-------|-----|
| Latest manifest | `https://github.com/strum-us/relaybase-worker/releases/latest/download/worker-install-manifest.json` |
| Versioned Worker JS | `https://github.com/strum-us/relaybase-worker/releases/download/vX.Y.Z/worker.X.Y.Z.js` |
| Versioned install ZIP | `https://github.com/strum-us/relaybase-worker/releases/download/vX.Y.Z/relaybase-worker-install-X.Y.Z.zip` |

## Desktop behavior

- **Fresh install:** downloads latest ZIP from manifest → deploy → stores `workerVersion` in workspace config.
- **Settings → Worker version:** compares installed version to GitHub manifest; **Update Worker** redeploys.
- Update offered only when manifest version **>** installed Worker and **≤** desktop app version.

## Local overrides

| Env var | Effect |
|---------|--------|
| `RELAYBASE_INSTALL_MANIFEST_URL` | Override manifest URL for desktop auto-install |
