import type { Env } from "../../env";
import { mintAccessToken, readConnection } from "../grant/cf-grant";
import type { UpdateAccess } from "./policy";

export async function readUpdateAccess(env: Env): Promise<UpdateAccess> {
  const connection = await readConnection(env);
  return {
    credential: connection.connected ? "grant" : null,
    accountId: connection.accountId,
    scriptName: env.WORKER_SCRIPT_NAME?.trim() || null,
    connection,
  };
}

/** A bearer token for the Cloudflare API and the script it may replace. */
export async function cloudflareToken(env: Env): Promise<{ token: string; accountId: string; scriptName: string }> {
  const access = await readUpdateAccess(env);
  if (access.credential !== "grant") {
    throw new Error("This Relaybase Worker has no Cloudflare permission. Reconnect Cloudflare from the Relaybase app.");
  }
  const scriptName = access.scriptName;
  if (!scriptName) throw new Error("This Relaybase Worker does not know its script name.");
  const minted = await mintAccessToken(env);
  return { token: minted.accessToken, accountId: minted.accountId, scriptName };
}
