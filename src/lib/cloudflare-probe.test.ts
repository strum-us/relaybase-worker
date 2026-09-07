// @ts-ignore node:test types are not bundled under @cloudflare/workers-types
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  probeCfApiTokenPermissions,
  probeCfApiTokenValid,
} from "./cloudflare-probe.ts";

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

function withFetch(
  impl: (url: string, init?: RequestInit) => Response,
  run: () => Promise<void>,
): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return impl(String(input), init);
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = previous;
  });
}

function zoneAndEditOk(url: string, init?: RequestInit): Response {
  if (url.includes("/zones?per_page=1") || url.includes("/zones?name=")) {
    return jsonOk([{ id: "zone-123", name: "example.com" }]);
  }
  // Email Routing status (GET /zones/{id}/email/routing)
  if (url.includes("/email/routing") && !url.includes("/email/routing/rules")) {
    return jsonOk({ enabled: false });
  }
  if (url.includes("/email/routing/rules")) {
    if (init?.method === "POST") {
      return jsonErr(400, 1004, "Validation error: actions required");
    }
    return jsonOk([]);
  }
  if (url.includes("/email/sending/subdomains")) {
    if (init?.method === "POST") {
      return jsonErr(400, 1004, "Validation error: name required");
    }
    return jsonOk([]);
  }
  if (url.includes("/dns_records")) {
    if (init?.method === "POST") {
      return jsonErr(400, 1004, "Validation error: record type required");
    }
    return jsonOk([]);
  }
  return jsonErr(404, 10000, "Not found");
}

describe("probeCfApiTokenPermissions", () => {
  it("returns ok for Zone Read, Email Routing Read, Email Routing Rules Edit, and DNS Edit", async () => {
    const urls: string[] = [];
    await withFetch((url, init) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      return zoneAndEditOk(url, init);
    }, async () => {
      const probe = await probeCfApiTokenPermissions("valid-token");
      assert.equal(probe.valid, true);
      assert.deepEqual(probe.permissions, {
        zoneRead: "ok",
        emailRoutingRead: "ok",
        emailRoutingEdit: "ok",
        emailSendingEdit: "ok",
        dnsEdit: "ok",
      });
    });
  });

  it("reports Email Routing Read as missing when GET /email/routing is 403", async () => {
    await withFetch((url, init) => {
      // Routing status endpoint returns 403 (missing Email Routing → Read)
      if (
        url.includes("/email/routing") &&
        !url.includes("/email/routing/rules")
      ) {
        return jsonErr(403, 9109, "Unauthorized to access requested resource");
      }
      return zoneAndEditOk(url, init);
    }, async () => {
      const probe = await probeCfApiTokenPermissions(
        "token-without-routing-read",
      );
      assert.equal(probe.valid, false);
      assert.equal(probe.permissions.emailRoutingRead, "missing");
      assert.equal(probe.permissions.emailRoutingEdit, "ok");
      assert.equal(probe.permissions.emailSendingEdit, "ok");
      assert.equal(probe.permissions.dnsEdit, "ok");
      assert.equal(probe.permissions.zoneRead, "ok");
    });
  });

  it("reports Email Routing Rules as missing when POST is 403", async () => {
    await withFetch((url, init) => {
      if (url.includes("/email/routing/rules") && init?.method === "POST") {
        return jsonErr(403, 9109, "Unauthorized to access requested resource");
      }
      if (url.includes("/email/routing/rules")) {
        return jsonErr(403, 9109, "Unauthorized to access requested resource");
      }
      return zoneAndEditOk(url, init);
    }, async () => {
      const probe = await probeCfApiTokenPermissions("token-without-routing-edit");
      assert.equal(probe.valid, false);
      assert.equal(probe.permissions.emailRoutingEdit, "missing");
      assert.equal(probe.permissions.emailSendingEdit, "ok");
      assert.equal(probe.permissions.dnsEdit, "ok");
      assert.equal(probe.permissions.zoneRead, "ok");
    });
  });

  it("reports DNS as read_only when GET works and POST is 403", async () => {
    await withFetch((url, init) => {
      if (url.includes("/dns_records") && init?.method === "POST") {
        return jsonErr(403, 9109, "Unauthorized to access requested resource");
      }
      return zoneAndEditOk(url, init);
    }, async () => {
      const probe = await probeCfApiTokenPermissions("token-with-dns-read-only");
      assert.equal(probe.valid, false);
      assert.equal(probe.permissions.dnsEdit, "read_only");
      assert.equal(probe.permissions.emailRoutingEdit, "ok");
      assert.equal(probe.permissions.emailRoutingRead, "ok");
      assert.equal(probe.permissions.emailSendingEdit, "ok");
      assert.equal(probe.permissions.zoneRead, "ok");
    });
  });

  it("reports Email Routing Rules as read_only when GET works and POST is 403", async () => {
    await withFetch((url, init) => {
      if (url.includes("/email/routing/rules") && init?.method === "POST") {
        return jsonErr(403, 9109, "Unauthorized to access requested resource");
      }
      return zoneAndEditOk(url, init);
    }, async () => {
      const probe = await probeCfApiTokenPermissions("token-with-routing-read-only");
      assert.equal(probe.valid, false);
      assert.equal(probe.permissions.emailRoutingEdit, "read_only");
      assert.equal(probe.permissions.emailSendingEdit, "ok");
      assert.equal(probe.permissions.dnsEdit, "ok");
    });
  });

  it("returns zoneRead unknown when no zones and no knownDomains", async () => {
    await withFetch((url) => {
      if (url.includes("/zones")) return jsonOk([]);
      return jsonErr(404, 10000, "Not found");
    }, async () => {
      const probe = await probeCfApiTokenPermissions("token-no-zones");
      assert.equal(probe.valid, false);
      assert.deepEqual(probe.permissions, {
        zoneRead: "unknown",
        emailRoutingRead: "skipped",
        emailRoutingEdit: "skipped",
        emailSendingEdit: "skipped",
        dnsEdit: "skipped",
      });
    });
  });

  it("reports zoneRead missing when zones list is empty and knownDomains also return empty", async () => {
    let callCount = 0;
    await withFetch((url) => {
      callCount++;
      // All zone queries return empty (simulates Zone Read missing)
      if (url.includes("/zones")) return jsonOk([]);
      return jsonErr(404, 10000, "Not found");
    }, async () => {
      const probe = await probeCfApiTokenPermissions("token-no-zone-read", {
        knownDomains: ["relaybase.xyz", "wedesk.so"],
      });
      assert.equal(probe.valid, false);
      assert.equal(probe.permissions.zoneRead, "missing");
      assert.equal(probe.permissions.emailRoutingEdit, "skipped");
      assert.equal(probe.permissions.emailSendingEdit, "skipped");
      assert.equal(probe.permissions.dnsEdit, "skipped");
      // 1 initial + 2 domain lookups = 3 calls
      assert.ok(callCount >= 3);
    });
  });

  it("resolves zone via knownDomains when initial list is empty", async () => {
    await withFetch((url, init) => {
      if (url.includes("/zones?per_page=1")) return jsonOk([]);
      if (url.includes("/zones?name=relaybase.xyz")) {
        return jsonOk([{ id: "zone-456", name: "relaybase.xyz" }]);
      }
      // routing status for zone-456
      if (
        url.includes("/zones/zone-456/email/routing") &&
        !url.includes("/email/routing/rules")
      ) {
        return jsonOk({ enabled: false });
      }
      // routing/DNS/sending probes for zone-456
      if (url.includes("/zones/zone-456/email/routing/rules")) {
        if (init?.method === "POST") {
          return jsonErr(400, 1004, "Validation error: actions required");
        }
        return jsonOk([]);
      }
      if (url.includes("/zones/zone-456/email/sending/subdomains")) {
        if (init?.method === "POST") {
          return jsonErr(400, 1004, "Validation error: name required");
        }
        return jsonOk([]);
      }
      if (url.includes("/zones/zone-456/dns_records")) {
        if (init?.method === "POST") {
          return jsonErr(400, 1004, "Validation error: record type required");
        }
        return jsonOk([]);
      }
      return jsonErr(404, 10000, "Not found");
    }, async () => {
      const probe = await probeCfApiTokenPermissions("token-zone-via-domain", {
        knownDomains: ["relaybase.xyz"],
      });
      assert.equal(probe.valid, true);
      assert.equal(probe.permissions.zoneRead, "ok");
      assert.equal(probe.permissions.emailRoutingRead, "ok");
      assert.equal(probe.permissions.emailRoutingEdit, "ok");
      assert.equal(probe.permissions.emailSendingEdit, "ok");
      assert.equal(probe.permissions.dnsEdit, "ok");
    });
  });

  it("reports Email Sending Edit as missing when POST /email/sending/subdomains is 403", async () => {
    await withFetch((url, init) => {
      if (url.includes("/email/sending/subdomains") && init?.method === "POST") {
        return jsonErr(403, 9109, "Unauthorized to access requested resource");
      }
      return zoneAndEditOk(url, init);
    }, async () => {
      const probe = await probeCfApiTokenPermissions("token-without-sending-edit");
      assert.equal(probe.valid, false);
      assert.equal(probe.permissions.emailSendingEdit, "missing");
      assert.equal(probe.permissions.emailRoutingEdit, "ok");
      assert.equal(probe.permissions.emailRoutingRead, "ok");
      assert.equal(probe.permissions.dnsEdit, "ok");
      assert.equal(probe.permissions.zoneRead, "ok");
    });
  });

  it("reports Zone Read missing when listing zones is 403", async () => {
    await withFetch((url) => {
      if (url.includes("/zones?per_page=1")) {
        return jsonErr(403, 9109, "Unauthorized to access requested resource");
      }
      return jsonErr(404, 10000, "Not found");
    }, async () => {
      const probe = await probeCfApiTokenPermissions("token-no-zone-read");
      assert.equal(probe.valid, false);
      assert.deepEqual(probe.permissions, {
        zoneRead: "missing",
        emailRoutingRead: "skipped",
        emailRoutingEdit: "skipped",
        emailSendingEdit: "skipped",
        dnsEdit: "skipped",
      });
    });
  });

  it("handles empty or whitespace token", async () => {
    const probe = await probeCfApiTokenPermissions("   ");
    assert.equal(probe.valid, false);
    assert.deepEqual(probe.permissions, {
      zoneRead: "missing",
      emailRoutingRead: "skipped",
      emailRoutingEdit: "skipped",
      emailSendingEdit: "skipped",
      dnsEdit: "skipped",
    });
  });

  it("treats HTTP 400/422 validation errors without auth rejection as allowed", async () => {
    await withFetch((url, init) => {
      if (url.includes("/zones?per_page=1")) {
        return jsonOk([{ id: "zone-123", name: "example.com" }]);
      }
      if (url.includes("/dns_records") && init?.method === "POST") {
        return jsonErr(422, 1004, "Invalid DNS record body");
      }
      return zoneAndEditOk(url, init);
    }, async () => {
      const probe = await probeCfApiTokenPermissions("valid-token");
      assert.equal(probe.valid, true);
      assert.equal(probe.permissions.dnsEdit, "ok");
    });
  });
});

describe("probeCfApiTokenValid", () => {
  it("returns true when all required probes pass", async () => {
    await withFetch(zoneAndEditOk, async () => {
      assert.equal(await probeCfApiTokenValid("valid-token"), true);
    });
  });

  it("returns false when DNS is read-only", async () => {
    await withFetch((url, init) => {
      if (url.includes("/dns_records") && init?.method === "POST") {
        return jsonErr(403, 9109, "Unauthorized to access requested resource");
      }
      return zoneAndEditOk(url, init);
    }, async () => {
      assert.equal(await probeCfApiTokenValid("token-with-dns-read-only"), false);
    });
  });

  it("returns false when Email Routing Read is missing", async () => {
    await withFetch((url, init) => {
      if (
        url.includes("/email/routing") &&
        !url.includes("/email/routing/rules")
      ) {
        return jsonErr(403, 9109, "Unauthorized to access requested resource");
      }
      return zoneAndEditOk(url, init);
    }, async () => {
      assert.equal(
        await probeCfApiTokenValid("token-without-routing-read"),
        false,
      );
    });
  });
});
