// @ts-ignore node:test types are not bundled under @cloudflare/workers-types
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildThreadingHeaders,
  isThreadingHeaderError,
  threadingHeaderErrorCode,
  tokenToMessageId,
} from "./threading-headers.ts";

describe("tokenToMessageId", () => {
  it("wraps a bare id", () => {
    assert.equal(tokenToMessageId("abc@x.com"), "<abc@x.com>");
  });

  it("keeps an already wrapped id", () => {
    assert.equal(tokenToMessageId("<abc@x.com>"), "<abc@x.com>");
  });

  it("drops tokens that are not id@host", () => {
    assert.equal(tokenToMessageId("not-a-message-id"), null);
    assert.equal(tokenToMessageId("<no-at>"), null);
  });

  it("drops tokens that still contain header breaks", () => {
    assert.equal(tokenToMessageId("bar@x.com>"), null);
  });
});

describe("buildThreadingHeaders", () => {
  it("dedupes and appends In-Reply-To onto References", () => {
    const headers = buildThreadingHeaders({
      inReplyTo: "abc@x.com",
      references: "abc@x.com <def@y.com>",
    });
    assert.equal(headers.inReplyTo, "<abc@x.com>");
    assert.equal(headers.references, "<abc@x.com> <def@y.com>");
    assert.equal(headers.referencesCount, 2);
  });

  it("strips CR/LF so a folded header cannot inject another header", () => {
    const headers = buildThreadingHeaders({
      inReplyTo: "abc@x.com\r\nBcc: evil@x.com",
    });
    assert.equal(headers.inReplyTo, "<abc@x.com>");
    assert.equal(headers.references, "<abc@x.com>");
    assert.equal(headers.references?.includes("evil"), false);
  });

  it("omits a broken parent id and still sends", () => {
    const headers = buildThreadingHeaders({
      inReplyTo: "not-an-id",
      references: "parent@example.com",
    });
    assert.equal(headers.inReplyTo, undefined);
    assert.equal(headers.hasInReplyTo, false);
    assert.equal(headers.references, "<parent@example.com>");
  });

  it("drops the oldest references once the value exceeds 2048 bytes", () => {
    const older = `${"a".repeat(2030)}@old.example`;
    const newer = "new@example.com";
    const headers = buildThreadingHeaders({
      references: `${older} ${newer}`,
    });
    assert.equal(headers.references, "<new@example.com>");
    assert.equal(headers.referencesCount, 1);
  });

  it("keeps at most 100 references, preferring the newest", () => {
    const ids = Array.from({ length: 101 }, (_, index) => `id${index}@ex.com`);
    const headers = buildThreadingHeaders({ references: ids.join(" ") });
    assert.equal(headers.referencesCount, 100);
    assert.equal(headers.references?.startsWith("<id1@ex.com>"), true);
    assert.equal(headers.references?.endsWith("<id100@ex.com>"), true);
    assert.equal(headers.references?.includes("<id0@ex.com>"), false);
  });
});

describe("threading header errors", () => {
  it("recognizes Cloudflare header error codes", () => {
    const message = "Header 'In-Reply-To' is not allowed. E_HEADER_NOT_ALLOWED";
    assert.equal(isThreadingHeaderError(new Error(message)), true);
    assert.equal(threadingHeaderErrorCode(message), "E_HEADER_NOT_ALLOWED");
    assert.equal(isThreadingHeaderError(new Error("recipient rejected")), false);
  });
});
