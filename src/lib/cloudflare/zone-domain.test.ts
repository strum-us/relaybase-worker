// @ts-ignore node:test types are not bundled under @cloudflare/workers-types
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  domainUsesParentZone,
  findParentZoneForDomain,
} from "./zone-domain.ts";

describe("findParentZoneForDomain", () => {
  const zones = [
    { id: "z1", name: "kloy.app", status: "active", accountId: "a", nameServers: [] },
    { id: "z2", name: "strum.us", status: "active", accountId: "a", nameServers: [] },
    { id: "z3", name: "us", status: "active", accountId: "a", nameServers: [] },
  ];

  it("picks the longest matching parent zone", () => {
    const match = findParentZoneForDomain("mail.kloy.app", zones);
    assert.equal(match?.name, "kloy.app");
    assert.equal(match?.id, "z1");
  });

  it("returns null for an apex domain with no exact zone in the list", () => {
    assert.equal(findParentZoneForDomain("missing.com", zones), null);
  });

  it("does not treat a suffix-only match as parent (example.com vs ample.com)", () => {
    assert.equal(findParentZoneForDomain("notkloy.app", zones), null);
  });
});

describe("domainUsesParentZone", () => {
  it("detects subdomain mail hosts", () => {
    assert.equal(domainUsesParentZone("mail.kloy.app", "kloy.app"), true);
    assert.equal(domainUsesParentZone("kloy.app", "kloy.app"), false);
  });
});
