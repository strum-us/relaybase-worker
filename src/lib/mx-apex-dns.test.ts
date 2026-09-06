import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isApexMxOwnerName,
  isCloudflareMxContent,
  normalizeDnsOwnerName,
} from "./mx-apex-dns.ts";

describe("normalizeDnsOwnerName", () => {
  it("lowercases and strips a trailing dot", () => {
    assert.equal(normalizeDnsOwnerName("Strum.US."), "strum.us");
    assert.equal(normalizeDnsOwnerName("@"), "@");
  });
});

describe("isApexMxOwnerName", () => {
  it("matches apex FQDN, @, and trailing-dot variants", () => {
    assert.equal(isApexMxOwnerName("strum.us", "strum.us"), true);
    assert.equal(isApexMxOwnerName("strum.us.", "strum.us"), true);
    assert.equal(isApexMxOwnerName("@", "strum.us"), true);
    assert.equal(isApexMxOwnerName("mail.strum.us", "strum.us"), false);
  });
});

describe("isCloudflareMxContent", () => {
  it("detects Cloudflare Email Routing MX targets", () => {
    assert.equal(isCloudflareMxContent("route1.mx.cloudflare.net"), true);
    assert.equal(isCloudflareMxContent("route1.mx.cloudflare.net."), true);
    assert.equal(isCloudflareMxContent("aspmx.l.google.com"), false);
  });
});
