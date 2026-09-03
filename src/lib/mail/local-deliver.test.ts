// @ts-ignore node:test types are not bundled under @cloudflare/workers-types
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { selectLocalInboundRecipients } from "./local-deliver-select.ts";
import type { MailboxAddress } from "../catalog-store.ts";

const addresses: MailboxAddress[] = [
  { email: "isaac@wedesk.so", domain: "wedesk.so" },
  { email: "support@wedesk.so", domain: "wedesk.so" },
  { email: "billing@kloyapp.com", domain: "kloyapp.com", inboundEnabled: false },
  { email: "jon@kloyapp.com", domain: "kloyapp.com" },
];

describe("selectLocalInboundRecipients", () => {
  it("keeps inbound-enabled local To/Cc and drops external plus inbound-off", () => {
    assert.deepEqual(
      selectLocalInboundRecipients(
        [
          "jon@kloyapp.com",
          "isaac@wedesk.so",
          "gssisaac@gmail.com",
          "billing@kloyapp.com",
          "support@wedesk.so",
        ],
        addresses,
      ),
      ["jon@kloyapp.com", "isaac@wedesk.so", "support@wedesk.so"],
    );
  });

  it("dedupes case and skips permanent bounces", () => {
    assert.deepEqual(
      selectLocalInboundRecipients(
        ["Isaac@Wedesk.so", "isaac@wedesk.so", "jon@kloyapp.com"],
        addresses,
        ["ISAAC@wedesk.so"],
      ),
      ["jon@kloyapp.com"],
    );
  });
});
