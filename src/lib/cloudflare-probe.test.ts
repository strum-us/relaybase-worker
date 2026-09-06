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
  it("returns true when Zone Read, Email Routing Rules Edit, and DNS Edit are all allowed", async () => {
    const urls: string[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/zones?per_page=1")) {
        return jsonOk([{ id: "zone-123", name: "example.com" }]);
      }
      if (url.includes("/email/routing/rules")) {
        // POST with empty body returns 400 schema validation error when Edit permission is granted
        assert.equal(init?.method, "POST");
        return jsonErr(400, 1004, "Validation error: actions required");
      }
      if (url.includes("/dns_records")) {
        // POST with empty body returns 400 schema validation error when Edit permission is granted
        assert.equal(init?.method, "POST");
        return jsonErr(400, 1004, "Validation error: record type required");
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

  it("returns false when Email Routing probe fails with 403 / 9109 Unauthorized", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/zones?per_page=1")) {
        return jsonOk([{ id: "zone-123", name: "hapfam.com" }]);
      }
      if (url.includes("/email/routing/rules")) {
        return jsonErr(403, 9109, "Unauthorized to access requested resource");
      }
      if (url.includes("/dns_records")) {
        return jsonErr(400, 1004, "Validation error");
      }
      return jsonErr(404, 10000, "Not found");
    }) as typeof fetch;

    try {
      const valid = await probeCfApiTokenValid("token-without-routing-edit");
      assert.equal(valid, false);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("returns false when DNS Edit probe fails with 403 Forbidden (e.g. DNS Read only)", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/zones?per_page=1")) {
        return jsonOk([{ id: "zone-123", name: "example.com" }]);
      }
      if (url.includes("/email/routing/rules")) {
        return jsonErr(400, 1004, "Validation error");
      }
      if (url.includes("/dns_records")) {
        return jsonErr(403, 9109, "Unauthorized to access requested resource");
      }
      return jsonErr(404, 10000, "Not found");
    }) as typeof fetch;

    try {
      const valid = await probeCfApiTokenValid("token-with-dns-read-only");
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
