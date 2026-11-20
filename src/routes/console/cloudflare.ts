import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth/auth";
import { issueReconnectCode, readConnection } from "../../lib/grant/cf-grant";
import { CLOUDFLARE_FEATURE_SCOPES } from "../../lib/grant/scopes";

/**
 * The Worker's Cloudflare connection (the stored OAuth grant). Owner only.
 * `GET /console/cloudflare` reports it; `POST /console/cloudflare/reconnect-code`
 * returns a one-time code the app's "Reconnect Cloudflare" flow hands back to
 * `/install/handoff` together with a fresh refresh token.
 */
const consoleCloudflare = new Hono<{ Bindings: Env }>();

consoleCloudflare.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const connection = await readConnection(c.env);
  const features = Object.fromEntries(
    Object.entries(CLOUDFLARE_FEATURE_SCOPES).map(([feature, scopes]) => [
      feature,
      connection.connected && scopes.every((scope) => connection.scopes.includes(scope)),
    ]),
  );
  return c.json({ ...connection, features, configured: Boolean(c.env.CF_GRANT_KEY && c.env.CF_OAUTH_CLIENT_ID) });
});

consoleCloudflare.post("/reconnect-code", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  if (!c.env.CF_GRANT_KEY || !c.env.CF_OAUTH_CLIENT_ID) {
    return c.json({ error: "unconfigured" }, 409);
  }
  return c.json({ code: await issueReconnectCode(c.env), expiresInSeconds: 600 });
});

export { consoleCloudflare };
