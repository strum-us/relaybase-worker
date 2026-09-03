// @ts-ignore node:test types are not bundled under @cloudflare/workers-types
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decodeBase64String,
  normalizeAttachmentBytes,
} from "./attachment-bytes.ts";
import { buildMimeMessage } from "./mime.ts";
import { parseInboundMime } from "./mime-parse.ts";

describe("normalizeAttachmentBytes", () => {
  it("decodes postal-mime base64 attachment strings to binary", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const b64 = btoa(String.fromCharCode(...png));
    const out = new Uint8Array(normalizeAttachmentBytes(b64));
    assert.deepEqual(out, png);
  });

  it("repairs legacy R2 objects that stored ASCII base64 text", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ascii = new TextEncoder().encode(btoa(String.fromCharCode(...png)));
    const out = new Uint8Array(normalizeAttachmentBytes(ascii.buffer));
    assert.deepEqual(out, png);
  });

  it("leaves plain-text attachments unchanged", () => {
    const text = "hello attachment";
    const out = new TextDecoder().decode(normalizeAttachmentBytes(text));
    assert.equal(out, text);
  });
});

describe("parseInboundMime attachments", () => {
  it("roundtrips multipart attachments with binary bodies", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const rawMime = buildMimeMessage({
      from: "sender@wedesk.so",
      to: "beta@relaybase.xyz",
      subject: "attachment test",
      text: "see attached",
      attachments: [
        {
          filename: "image.png",
          contentType: "image/png",
          content: png.buffer,
        },
      ],
    });
    const parsed = await parseInboundMime(
      new TextEncoder().encode(rawMime).buffer,
    );
    assert.equal(parsed.attachments.length, 1);
    const stored = new Uint8Array(parsed.attachments[0]!.content);
    assert.deepEqual(stored, png);
  });
});

describe("decodeBase64String", () => {
  it("rejects invalid base64", () => {
    assert.equal(decodeBase64String("not!!!base64"), null);
  });
});
