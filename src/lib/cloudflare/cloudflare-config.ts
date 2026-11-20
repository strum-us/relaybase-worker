import type { Env } from "../../env";
import { mintAccessToken, readConnection } from "../grant/cf-grant.ts";
import { normalizeCfAccountId } from "./cf-account-id.ts";
import { CloudflareClient } from "./cloudflare-client.ts";

/** Shown wherever a Cloudflare API call needs the grant and the Worker has none. */
export const CLOUDFLARE_NOT_CONNECTED_MESSAGE =
  "This Relaybase Worker is not connected to Cloudflare. Reconnect Cloudflare from Settings › Cloudflare in the Relaybase app.";

/**
 * Cloudflare API client on an access token minted from the stored OAuth grant
 * (src/lib/grant/cf-grant.ts). Used for zones, DNS, Email Routing, Email
 * Sending and D1 status — not for send when the EMAIL binding is present.
 */
export async function createCloudflareClient(
  env: Env,
  opts?: { accountId?: string | null },
): Promise<CloudflareClient> {
  const connection = await readConnection(env);
  if (!connection.connected) throw new Error(CLOUDFLARE_NOT_CONNECTED_MESSAGE);
  const minted = await mintAccessToken(env);
  const accountId =
    normalizeCfAccountId(opts?.accountId) ||
    normalizeCfAccountId(env.CF_ACCOUNT_ID) ||
    normalizeCfAccountId(minted.accountId) ||
    "";
  return new CloudflareClient({ accountId, apiToken: minted.accessToken });
}

/** Whether this Worker holds a Cloudflare grant it can call the API with. */
export async function cloudflareRuntimeConfigured(env: Env): Promise<boolean> {
  return (await readConnection(env)).connected;
}

/** An access token for best-effort reads (D1 sizes); undefined when there is no grant or it cannot be renewed. */
export async function cloudflareAccessTokenOrUndefined(env: Env): Promise<string | undefined> {
  try {
    if (!(await readConnection(env)).connected) return undefined;
    return (await mintAccessToken(env)).accessToken;
  } catch {
    return undefined;
  }
}
