#!/usr/bin/env bash
# Upload the packed Worker install artifacts to the public downloads bucket.
# GitHub Release upload stays in publish-github-release.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
ORIGIN="${RELAYBASE_DOWNLOADS_ORIGIN:-https://downloads.relaybase.email}"
BUCKET="${RELAYBASE_DOWNLOADS_BUCKET:-relaybase-downloads}"
DIR="${RELAYBASE_DOWNLOADS_DIR:-$ROOT/dist/downloads}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-3adf03d991843094a7343eebc0a98007}"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is required to upload install artifacts to R2." >&2
  exit 1
fi

WORKER_JS="$DIR/worker.${VERSION}.js"
ZIP="$DIR/relaybase-worker-install-${VERSION}.zip"
ZIP_ALIAS="$DIR/relaybase-worker-install.zip"
MANIFEST="$DIR/worker-install-manifest.json"

for f in "$WORKER_JS" "$ZIP" "$ZIP_ALIAS" "$MANIFEST"; do
  if [[ ! -f "$f" ]]; then
    echo "Missing pack output: $f" >&2
    exit 1
  fi
done

put() {
  local key="$1"
  local file="$2"
  local content_type="$3"
  local cache_control="$4"
  pnpm exec wrangler r2 object put "${BUCKET}/${key}" \
    --file "$file" \
    --content-type "$content_type" \
    --cache-control "$cache_control" \
    --remote \
    -c wrangler.downloads.jsonc
}

IMMUTABLE="public, max-age=31536000, immutable"
LATEST="public, max-age=60, must-revalidate"
PREFIX="v${VERSION}"

echo "Uploading Worker ${VERSION} to R2 bucket ${BUCKET}…"
put "${PREFIX}/worker.${VERSION}.js" "$WORKER_JS" "application/javascript" "$IMMUTABLE"
put "${PREFIX}/relaybase-worker-install-${VERSION}.zip" "$ZIP" "application/zip" "$IMMUTABLE"
put "${PREFIX}/worker-install-manifest.json" "$MANIFEST" "application/json" "$IMMUTABLE"
put "worker-install-manifest.json" "$MANIFEST" "application/json" "$LATEST"
put "relaybase-worker-install.zip" "$ZIP" "application/zip" "$LATEST"

echo "R2 manifest: ${ORIGIN}/worker-install-manifest.json"
echo "R2 ZIP:      ${ORIGIN}/${PREFIX}/relaybase-worker-install-${VERSION}.zip"
