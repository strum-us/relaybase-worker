import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { compareVersions, isVersion } from "./semver.ts";
import { automaticSkip, blockedReason, rolloutBucket, type UpdateAccess } from "./policy.ts";
import { parseSignature, verifySignature } from "./signature.ts";

const connected: UpdateAccess = {
  credential: "grant",
  accountId: "acc",
  scriptName: "relaybase-api",
  connection: { connected: true, accountId: "acc", scopes: ["workers-scripts.write"], updatedAt: null },
};
const configuredEnv = {
  RELEASE_ORIGIN: "https://downloads.relaybase.email/release",
  WORKER_SCRIPT_NAME: "relaybase-api",
  CF_OAUTH_CLIENT_ID: "client",
  CF_GRANT_KEY: "key",
};

describe("versions", () => {
  it("orders semver with prereleases first", () => {
    assert.ok(compareVersions("0.2.0", "0.1.13") > 0);
    assert.ok(compareVersions("0.2.0-staging.1", "0.2.0") < 0);
    assert.ok(compareVersions("0.2.0-staging.2", "0.2.0-staging.10") < 0);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.ok(isVersion("0.2.0-staging.1"));
    assert.ok(!isVersion("v0.2"));
  });
});

describe("update policy", () => {
  it("blocks without grant, scopes, config, or in dev", () => {
    assert.equal(blockedReason(configuredEnv, connected), null);
    assert.equal(blockedReason({ ...configuredEnv, RELAYBASE_DEV: "1" }, connected), "development");
    assert.equal(blockedReason({ ...configuredEnv, RELEASE_ORIGIN: "" }, connected), "no_release_origin");
    assert.equal(blockedReason({ ...configuredEnv, CF_GRANT_KEY: undefined }, connected), "unconfigured");
    assert.equal(
      blockedReason(configuredEnv, { ...connected, credential: null, connection: { ...connected.connection, connected: false } }),
      "not_connected",
    );
    assert.equal(
      blockedReason(configuredEnv, { ...connected, connection: { ...connected.connection, scopes: ["d1.write"] } }),
      "missing_scopes",
    );
  });

  it("keeps rollout buckets stable and in range", () => {
    const bucket = rolloutBucket("acc:relaybase-api");
    assert.equal(bucket, rolloutBucket("acc:relaybase-api"));
    assert.ok(bucket >= 0 && bucket < 100);
  });

  it("starts automatic updates only for newer, auto, not-tried releases", () => {
    const base = { enabled: true, blocked: false, newer: true, release: { autoUpdate: true }, held: false, triedBefore: false };
    assert.equal(automaticSkip(base), null);
    assert.equal(automaticSkip({ ...base, enabled: false }), "off");
    assert.equal(automaticSkip({ ...base, newer: false }), "up_to_date");
    assert.equal(automaticSkip({ ...base, release: { autoUpdate: false } }), "needs_owner");
    assert.equal(automaticSkip({ ...base, triedBefore: true }), "tried_before");
  });
});

describe("release signatures", () => {
  it("accepts the release key and rejects tampered bytes", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    const keys = [{ id: "k1", publicKey: raw.toString("base64") }];
    const body = new TextEncoder().encode('{"version":"0.2.0"}');
    const sig = parseSignature(JSON.stringify({ keyId: "k1", signature: sign(null, body, privateKey).toString("base64") }))!;
    assert.equal(await verifySignature(keys, body, sig), true);
    assert.equal(await verifySignature(keys, new TextEncoder().encode('{"version":"9.9.9"}'), sig), false);
    assert.equal(await verifySignature([{ id: "k1", publicKey: Buffer.alloc(32).toString("base64") }], body, sig), false);
  });
});
