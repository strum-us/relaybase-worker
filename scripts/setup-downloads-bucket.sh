#!/usr/bin/env bash
# One-time: public R2 bucket + CORS + downloads.relaybase.email.
# Requires CLOUDFLARE_API_TOKEN for account 3adf03d991843094a7343eebc0a98007
# (R2 edit + zone DNS edit on relaybase.email).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUCKET="${RELAYBASE_DOWNLOADS_BUCKET:-relaybase-downloads}"
DOMAIN="${RELAYBASE_DOWNLOADS_DOMAIN:-downloads.relaybase.email}"
ZONE_NAME="${RELAYBASE_DOWNLOADS_ZONE:-relaybase.email}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-3adf03d991843094a7343eebc0a98007}"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "Set CLOUDFLARE_API_TOKEN for the Relaybase Cloudflare account, then re-run." >&2
  exit 1
fi

if ! pnpm exec wrangler r2 bucket info "$BUCKET" -c wrangler.downloads.jsonc >/dev/null 2>&1; then
  echo "Creating R2 bucket ${BUCKET}…"
  pnpm exec wrangler r2 bucket create "$BUCKET" -c wrangler.downloads.jsonc
else
  echo "R2 bucket ${BUCKET} already exists."
fi

echo "Setting CORS…"
pnpm exec wrangler r2 bucket cors set "$BUCKET" \
  --file "$ROOT/downloads-cors.json" \
  -y \
  -c wrangler.downloads.jsonc

ZONE_ID="${RELAYBASE_DOWNLOADS_ZONE_ID:-}"
if [[ -z "$ZONE_ID" ]]; then
  ZONE_ID="$(
    curl -fsS \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      "https://api.cloudflare.com/client/v4/zones?name=${ZONE_NAME}&account.id=${CLOUDFLARE_ACCOUNT_ID}" \
      | node -e "
const fs = require('fs');
const body = JSON.parse(fs.readFileSync(0, 'utf8'));
const zone = (body.result || []).find((z) => z.name === process.argv[1]);
if (!zone) {
  console.error('Zone not found: ' + process.argv[1]);
  process.exit(1);
}
process.stdout.write(zone.id);
" "$ZONE_NAME"
  )"
fi

echo "Attaching ${DOMAIN} (zone ${ZONE_ID})…"
if pnpm exec wrangler r2 bucket domain get "$BUCKET" --domain "$DOMAIN" -c wrangler.downloads.jsonc >/dev/null 2>&1; then
  echo "Custom domain ${DOMAIN} is already attached."
else
  pnpm exec wrangler r2 bucket domain add "$BUCKET" \
    --domain "$DOMAIN" \
    --zone-id "$ZONE_ID" \
    --min-tls 1.2 \
    -y \
    -c wrangler.downloads.jsonc
fi

echo "Downloads origin: https://${DOMAIN}"
