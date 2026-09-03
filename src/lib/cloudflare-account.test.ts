// @ts-ignore node:test types are not bundled under @cloudflare/workers-types
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveCfAccountIdFromToken } from "./cloudflare-account.ts";

const ACCOUNT = "3adf03d991843094a7343eebc0a98007";
const OTHER = "674a35f00d9800eec7d6bc42fe55726e";

describe("resolveCfAccountIdFromToken", () => {
  it("returns the id only when GET /accounts has exactly one account", async () => {
    const previous = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "not-an-id" }, { id: ACCOUNT }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      assert.equal(await resolveCfAccountIdFromToken("token"), ACCOUNT);
      assert.equal(seen.length, 1);
      assert.match(seen[0] ?? "", /\/accounts\?/);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("returns null when the token can see more than one account", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: [{ id: ACCOUNT }, { id: OTHER }],
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      assert.equal(await resolveCfAccountIdFromToken("token"), null);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("returns null when the token cannot list accounts", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: false }), {
        status: 403,
      })) as typeof fetch;
    try {
      assert.equal(await resolveCfAccountIdFromToken("token"), null);
      assert.equal(await resolveCfAccountIdFromToken("  "), null);
    } finally {
      globalThis.fetch = previous;
    }
  });
});
