// @ts-ignore node:test types are not bundled under @cloudflare/workers-types
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  cloudflareRuntimeConfigured,
  readCloudflareRuntimeConfig,
} from "./cloudflare-config.ts";

describe("readCloudflareRuntimeConfig", () => {
  it("requires CF_API_TOKEN only", async () => {
    assert.equal(
      await readCloudflareRuntimeConfig({ CF_API_TOKEN: "" } as never),
      null,
    );
    const withToken = await readCloudflareRuntimeConfig({
      CF_API_TOKEN: " tok ",
      CF_ACCOUNT_ID: "",
    } as never);
    assert.deepEqual(withToken, { accountId: "", apiToken: "tok" });
  });

  it("keeps a valid optional CF_ACCOUNT_ID", async () => {
    const id = "3adf03d991843094a7343eebc0a98007";
    const config = await readCloudflareRuntimeConfig({
      CF_API_TOKEN: "tok",
      CF_ACCOUNT_ID: id,
    } as never);
    assert.deepEqual(config, { accountId: id, apiToken: "tok" });
  });

  it("drops placeholder CF_ACCOUNT_ID values", async () => {
    const config = await readCloudflareRuntimeConfig({
      CF_API_TOKEN: "tok",
      CF_ACCOUNT_ID: "CF_ACCOUNT_ID",
    } as never);
    assert.deepEqual(config, { accountId: "", apiToken: "tok" });
  });
});

describe("cloudflareRuntimeConfigured", () => {
  it("is true with a token and no account id", async () => {
    assert.equal(
      await cloudflareRuntimeConfigured({ CF_API_TOKEN: "tok" } as never),
      true,
    );
    assert.equal(
      await cloudflareRuntimeConfigured({ CF_ACCOUNT_ID: "x" } as never),
      false,
    );
  });
});
