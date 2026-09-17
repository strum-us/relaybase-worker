// @ts-ignore node:test types are not bundled under @cloudflare/workers-types
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { selectLocalInboundRecipients } from "./local-deliver-select.ts";
import type { MailboxAddress } from "../catalog/catalog-store.ts";

const addresses: MailboxAddress[] = [
  { email: "ada@example.com", domain: "example.com" },
  { email: "support@example.com", domain: "example.com" },
  { email: "billing@example.org", domain: "example.org", inboundEnabled: false },
  { email: "jon@example.org", domain: "example.org" },
];

describe("selectLocalInboundRecipients", () => {
  it("keeps inbound-enabled local To/Cc and drops external plus inbound-off", () => {
    assert.deepEqual(
      selectLocalInboundRecipients(
        [
          "jon@example.org",
          "ada@example.com",
          "alice@example.net",
          "billing@example.org",
          "support@example.com",
        ],
        addresses,
      ),
      ["jon@example.org", "ada@example.com", "support@example.com"],
    );
  });

  it("dedupes case and skips permanent bounces", () => {
    assert.deepEqual(
      selectLocalInboundRecipients(
        ["Ada@Example.com", "ada@example.com", "jon@example.org"],
        addresses,
        ["ADA@example.com"],
      ),
      ["jon@example.org"],
    );
  });
});
