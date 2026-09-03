// @ts-ignore node:test types are not bundled under @cloudflare/workers-types
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  generatePasstoken,
  isValidPasstokenFormat,
  passtokenPrefix,
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
} from "./owner-tokens.ts";

const TEST_PEPPER = "test-pepper-0123456789abcdef";

describe("owner-auth passtoken", () => {
  it("generates a prefixed, high-entropy passtoken", () => {
    const t = generatePasstoken();
    assert.ok(t.startsWith("rb_pass_"));
    assert.ok(isValidPasstokenFormat(t));
    assert.equal(passtokenPrefix(t).length, 10);
  });

  it("rejects malformed passtokens", () => {
    assert.equal(isValidPasstokenFormat(""), false);
    assert.equal(isValidPasstokenFormat("rb_pass_x"), false);
    assert.equal(isValidPasstokenFormat("rb_admin_abc"), false);
  });
});

describe("owner-auth access token", () => {
  it("round-trips a signed access token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: "owner", iat: now, exp: now + 60, jti: "jti-1", scope: "mail" as const };
    const token = await signAccessToken(TEST_PEPPER, payload);
    const verified = await verifyAccessToken(TEST_PEPPER, token);
    assert.deepEqual(verified, payload);
  });

  it("rejects a token signed with a different pepper", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signAccessToken(TEST_PEPPER, {
      sub: "owner",
      iat: now,
      exp: now + 60,
      jti: "jti-2",
    });
    const verified = await verifyAccessToken("wrong-pepper", token);
    assert.equal(verified, null);
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signAccessToken(TEST_PEPPER, {
      sub: "owner",
      iat: now - 120,
      exp: now - 60,
      jti: "jti-3",
    });
    const verified = await verifyAccessToken(TEST_PEPPER, token);
    assert.equal(verified, null);
  });

  it("rejects a tampered token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signAccessToken(TEST_PEPPER, {
      sub: "owner",
      iat: now,
      exp: now + 60,
      jti: "jti-4",
    });
    const [body] = token.split(".");
    const tampered = `${body}.deadbeef`;
    const verified = await verifyAccessToken(TEST_PEPPER, tampered);
    assert.equal(verified, null);
  });
});

describe("owner-auth refresh token", () => {
  it("generates an opaque refresh token", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    assert.ok(a.length > 32);
    assert.notEqual(a, b);
  });
});
