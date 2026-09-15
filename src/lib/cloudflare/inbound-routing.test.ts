// @ts-ignore node:test types are not bundled under @cloudflare/workers-types
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CloudflareClient } from "./cloudflare-client.ts";
import { listInboundRoutingForDomains, reenableDisabledWorkerRules } from "./inbound-routing.ts";

const ACCOUNT_A = "3adf03d991843094a7343eebc0a98007";

function jsonOk(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
  });
}

describe("listInboundRoutingForDomains", () => {
  it("flags a domain whose worker rule was left enabled:false by Cloudflare", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return jsonOk([
          { id: "z-ready", name: "ready.xyz", account: { id: ACCOUNT_A } },
          { id: "z-broken", name: "broken.xyz", account: { id: ACCOUNT_A } },
        ]);
      }
      if (url.includes("/email/routing/rules")) {
        if (url.includes("z-broken")) {
          return jsonOk([
            {
              id: "rule-1",
              enabled: false,
              matchers: [{ type: "literal", field: "to", value: "hello@broken.xyz" }],
              actions: [{ type: "worker", value: ["relaybase-worker"] }],
            },
          ]);
        }
        return jsonOk([
          {
            id: "rule-2",
            enabled: true,
            matchers: [{ type: "literal", field: "to", value: "hello@ready.xyz" }],
            actions: [{ type: "worker", value: ["relaybase-worker"] }],
          },
        ]);
      }
      if (url.includes("/email/routing")) {
        return jsonOk({ enabled: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const cf = new CloudflareClient({ accountId: ACCOUNT_A, apiToken: "tok" });
      const results = await listInboundRoutingForDomains(cf, ["ready.xyz", "broken.xyz"]);

      const ready = results.find((r) => r.domain === "ready.xyz");
      const broken = results.find((r) => r.domain === "broken.xyz");
      assert.ok(ready && !("error" in ready));
      assert.ok(broken && !("error" in broken));
      if ("rules" in ready! && "rules" in broken!) {
        assert.deepEqual(
          ready.rules.map((r) => r.enabled),
          [true],
        );
        assert.deepEqual(
          broken.rules.map((r) => r.enabled),
          [false],
        );
        assert.equal(broken.rules[0]?.action, "worker");
      }
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("flags a registered address with no Cloudflare rule at all as missing, distinct from a disabled rule", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return jsonOk([
          { id: "z-drift", name: "drift.xyz", account: { id: ACCOUNT_A } },
        ]);
      }
      if (url.includes("/email/routing/rules")) {
        return jsonOk([
          {
            id: "rule-1",
            enabled: true,
            matchers: [{ type: "literal", field: "to", value: "jon@drift.xyz" }],
            actions: [{ type: "worker", value: ["relaybase-worker"] }],
          },
        ]);
      }
      if (url.includes("/email/routing")) {
        return jsonOk({ enabled: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const cf = new CloudflareClient({ accountId: ACCOUNT_A, apiToken: "tok" });
      const results = await listInboundRoutingForDomains(cf, ["drift.xyz"], {
        "drift.xyz": ["jon@drift.xyz", "hello@drift.xyz", "HELLO@drift.xyz"],
      });
      const drift = results.find((r) => r.domain === "drift.xyz");
      assert.ok(drift && !("error" in drift));
      if (drift && "missingAddresses" in drift) {
        assert.deepEqual(drift.missingAddresses, ["hello@drift.xyz"]);
      }
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("paginates Cloudflare routing rules so addresses beyond page 1 are not false missing", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return jsonOk([
          { id: "z-many", name: "many.xyz", account: { id: ACCOUNT_A } },
        ]);
      }
      if (url.includes("/email/routing/rules")) {
        const page = new URL(url).searchParams.get("page") ?? "1";
        if (page === "1") {
          const page1 = Array.from({ length: 50 }, (_, i) => ({
            id: `rule-${i}`,
            enabled: true,
            matchers: [
              { type: "literal", field: "to", value: `a${i}@many.xyz` },
            ],
            actions: [{ type: "worker", value: ["relaybase-worker"] }],
          }));
          return new Response(
            JSON.stringify({
              success: true,
              result: page1,
              result_info: { total_pages: 2, page: 1, per_page: 50 },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            result: [
              {
                id: "rule-last",
                enabled: true,
                matchers: [
                  { type: "literal", field: "to", value: "z-last@many.xyz" },
                ],
                actions: [{ type: "worker", value: ["relaybase-worker"] }],
              },
            ],
            result_info: { total_pages: 2, page: 2, per_page: 50 },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/email/routing")) {
        return jsonOk({ enabled: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const cf = new CloudflareClient({ accountId: ACCOUNT_A, apiToken: "tok" });
      const results = await listInboundRoutingForDomains(cf, ["many.xyz"], {
        "many.xyz": ["z-last@many.xyz"],
      });
      const many = results.find((r) => r.domain === "many.xyz");
      assert.ok(many && !("error" in many));
      if (many && "missingAddresses" in many) {
        assert.deepEqual(many.missingAddresses, []);
      }
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("load-more continues past 100 rules when Cloudflare omits result_info", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return jsonOk([
          { id: "z-huge", name: "huge.xyz", account: { id: ACCOUNT_A } },
        ]);
      }
      if (url.includes("/email/routing/rules")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        if (page <= 3) {
          const batch = Array.from({ length: 50 }, (_, i) => ({
            id: `rule-p${page}-${i}`,
            enabled: true,
            matchers: [
              {
                type: "literal",
                field: "to",
                value: `p${page}-${i}@huge.xyz`,
              },
            ],
            actions: [{ type: "worker", value: ["relaybase-worker"] }],
          }));
          return new Response(
            JSON.stringify({ success: true, result: batch }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            result: [
              {
                id: "rule-target",
                enabled: true,
                matchers: [
                  {
                    type: "literal",
                    field: "to",
                    value: "target@huge.xyz",
                  },
                ],
                actions: [{ type: "worker", value: ["relaybase-worker"] }],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/email/routing")) {
        return jsonOk({ enabled: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const cf = new CloudflareClient({ accountId: ACCOUNT_A, apiToken: "tok" });
      const results = await listInboundRoutingForDomains(cf, ["huge.xyz"], {
        "huge.xyz": ["target@huge.xyz"],
      });
      const huge = results.find((r) => r.domain === "huge.xyz");
      assert.ok(huge && !("error" in huge));
      if (huge && "missingAddresses" in huge) {
        assert.deepEqual(huge.missingAddresses, []);
        assert.equal(huge.rules.length, 151);
      }
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("captures a per-domain error instead of failing the whole batch", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return jsonOk([]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const cf = new CloudflareClient({ accountId: ACCOUNT_A, apiToken: "tok" });
      const results = await listInboundRoutingForDomains(cf, ["missing.xyz"]);
      assert.equal(results.length, 1);
      assert.ok("error" in results[0]!);
      assert.match((results[0] as { error: string }).error, /Could not resolve/);
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe("reenableDisabledWorkerRules", () => {
  it("re-enables a disabled worker rule even for an address no longer registered", async () => {
    const previous = globalThis.fetch;
    const putBodies: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/zones?")) {
        return jsonOk([{ id: "z-1", name: "orphan.xyz", account: { id: ACCOUNT_A } }]);
      }
      if (url.includes("/email/routing/rules/rule-orphan")) {
        putBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        return jsonOk({
          id: "rule-orphan",
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: "old@orphan.xyz" }],
          actions: [{ type: "worker", value: ["relaybase-worker"] }],
        });
      }
      if (url.includes("/email/routing/rules")) {
        return jsonOk([
          {
            id: "rule-orphan",
            enabled: false,
            matchers: [{ type: "literal", field: "to", value: "old@orphan.xyz" }],
            actions: [{ type: "worker", value: ["relaybase-worker"] }],
          },
          {
            id: "rule-drop",
            enabled: false,
            matchers: [{ type: "literal", field: "to", value: "muted@orphan.xyz" }],
            actions: [{ type: "drop" }],
          },
        ]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const cf = new CloudflareClient({ accountId: ACCOUNT_A, apiToken: "tok" });
      const result = await reenableDisabledWorkerRules(cf, "orphan.xyz");

      // Only the disabled `worker` rule is touched — the disabled `drop` rule
      // (an intentionally muted address) is left alone.
      assert.deepEqual(
        result.reenabled.map((r) => r.address),
        ["old@orphan.xyz"],
      );
      assert.equal(putBodies.length, 1);
      assert.equal((putBodies[0] as { enabled: boolean }).enabled, true);
    } finally {
      globalThis.fetch = previous;
    }
  });
});
