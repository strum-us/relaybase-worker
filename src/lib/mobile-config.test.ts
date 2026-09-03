// @ts-ignore node:test types are not bundled under @cloudflare/workers-types
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  constantTimeEqual,
  generateMobilePassword,
  generateMobileSalt,
  hashMobilePassword,
} from "./mobile-config.ts";

describe("mobile-config", () => {
  it("generates a 12-char alphanumeric password and hex salt", () => {
    const password = generateMobilePassword();
    const salt = generateMobileSalt();
    assert.equal(password.length, 12);
    assert.ok(/^[A-Za-z0-9]+$/.test(password));
    assert.ok(/^[0-9a-f]+$/.test(salt));
    assert.ok(salt.length > 16);
  });

  it("hashes the same password + salt deterministically", async () => {
    const salt = generateMobileSalt();
    const a = await hashMobilePassword("hunter2", salt);
    const b = await hashMobilePassword("hunter2", salt);
    assert.equal(a, b);
    assert.notEqual(a, await hashMobilePassword("hunter3", salt));
    assert.notEqual(a, await hashMobilePassword("hunter2", generateMobileSalt()));
  });

  it("compares strings in constant time", () => {
    assert.equal(constantTimeEqual("abc", "abc"), true);
    assert.equal(constantTimeEqual("abc", "abd"), false);
    assert.equal(constantTimeEqual("abc", "abcd"), false);
    assert.equal(constantTimeEqual("", ""), true);
  });
});
