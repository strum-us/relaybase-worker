// @ts-ignore node:test types are not bundled under @cloudflare/workers-types
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isSendingOwnedDnsRecord } from "./sending-onboard-dns.ts";

describe("isSendingOwnedDnsRecord", () => {
  it("matches only cf-bounce MX/TXT — not Email Routing DMARC/DKIM", () => {
    assert.equal(
      isSendingOwnedDnsRecord(
        { type: "MX", name: "cf-bounce.relaybase.xyz" },
        "relaybase.xyz",
      ),
      true,
    );
    assert.equal(
      isSendingOwnedDnsRecord(
        { type: "TXT", name: "cf-bounce.relaybase.xyz" },
        "relaybase.xyz",
      ),
      true,
    );
    assert.equal(
      isSendingOwnedDnsRecord(
        { type: "TXT", name: "_dmarc.relaybase.xyz" },
        "Relaybase.xyz",
      ),
      false,
    );
    assert.equal(
      isSendingOwnedDnsRecord(
        { type: "TXT", name: "cf2024-1._domainkey.relaybase.xyz" },
        "relaybase.xyz",
      ),
      false,
    );
    assert.equal(
      isSendingOwnedDnsRecord(
        { type: "MX", name: "relaybase.xyz" },
        "relaybase.xyz",
      ),
      false,
    );
  });
});
