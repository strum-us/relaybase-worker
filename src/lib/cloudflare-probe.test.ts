// @ts-ignore node:test types are not bundled under @cloudflare/workers-types
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { probeCfApiTokenValid } from "./cloudflare-probe.ts";

function jsonOk(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
  });
}

function jsonErr(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({
      success: false,
      errors: [{ code, message }],
    }),
    { status },
  );
}

describe("probeCfApiTokenValid", () => {
  it("returns true when Zone Read, Email Routing, and DNS are all allowed", async () => {
    const urls: string[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/zones?per_page=1")) {
        return jsonOk([{ id: "zone-123", name: "example.com" }]);
      }
      if (url.includes("/email/routing")) {
        return jsonOk({ enabled: true });
      }
      if (url.includes("/dns_records")) {
        return jsonOk([]);
      }
      return jsonErr(404, 10000, "Not found");
    }) as typeof fetch;

    try {
      const valid = await probeCfApiTokenValid("valid-token");
      assert.equal(valid, true);
      assert.equal(urls.length, 3);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("returns false when Email Routing probe fails with 10000 Authentication error", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/zones?per_page=1")) {
        return jsonOk([{ id: "zone-123", name: "hapfam.com" }]);
      }
      if (url.includes("/email/routing")) {
        return jsonErr(400, 10000, "Authentication error");
      }
      if (url.includes("/dns_records")) {
        return jsonOk([]);
      }
      return jsonErr(404, 10000, "Not found");
    }) as typeof fetch;

    try {
      const valid = await probeCfApiTokenValid("token-without-routing");
      assert.equal(valid, false);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("returns false when DNS probe fails", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/zones?per_page=1")) {
        return jsonOk([{ id: "zone-123", name: "example.com" }]);
      }
      if (url.includes("/email/routing")) {
        return jsonOk({ enabled: true });
      }
      if (url.includes("/dns_records")) {
        return jsonErr(403, 10000, "Authentication error");
      }
      return jsonErr(404, 10000, "Not found");
    }) as typeof fetch;

    try {
      const valid = await probeCfApiTokenValid("token-without-dns");
      assert.equal(valid, false);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("returns true when account has no zones yet and Zone Read passes", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/zones?per_page=1")) {
        return jsonOk([]);
      }
      return jsonErr(404, 10000, "Not found");
    }) as typeof fetch;

    try {
      const valid = await probeCfApiTokenValid("token-no-zones");
      assert.equal(valid, true);
    } finally {
      globalThis.fetch = previous;
    }
  });
});
