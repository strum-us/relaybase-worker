// @ts-ignore node:test types are not bundled under @cloudflare/workers-types
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizeCfAccountId } from "./cf-account-id.ts";

const ACCOUNT = "3adf03d991843094a7343eebc0a98007";
const OWNER_AUTH_SRC = readFileSync(
  new URL("./owner-auth.ts", import.meta.url),
  "utf8",
);

describe("owner-auth local normalizeCfAccountId binding", () => {
  it("imports the helper for local use — re-export-only 500s in the Worker bundle", () => {
    // `export { x } from './y'` does not bind `x` in native ESM / wrangler.
    // resetOwner calls normalizeCfAccountId in this file; without a local
    // import, POST /console/reset-admin throws and the UI shows Internal server error.
    assert.match(
      OWNER_AUTH_SRC,
      /import\s*\{[^}]*\bnormalizeCfAccountId\b[^}]*\}\s*from\s*["'][^"']*cf-account-id/,
    );
    assert.equal(
      /export\s*\{\s*normalizeCfAccountId\s*\}\s*from/.test(OWNER_AUTH_SRC),
      false,
    );
    assert.match(OWNER_AUTH_SRC, /\bnormalizeCfAccountId\(/);
  });
});

describe("normalizeCfAccountId", () => {
  it("rejects binding placeholder strings", () => {
    assert.equal(normalizeCfAccountId("cf_account_id"), null);
    assert.equal(normalizeCfAccountId("CF_ACCOUNT_ID"), null);
  });

  it("accepts 32-char hex ids", () => {
    assert.equal(normalizeCfAccountId(ACCOUNT), ACCOUNT);
  });
});
