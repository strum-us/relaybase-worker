import { Hono } from "hono";
import type { Env } from "../env";
import {
  acceptRefreshToken,
  consumeReconnectCode,
  grantReadable,
  handoffConsumed,
  hmacHex,
  markHandoffConsumed,
  reconnectCodeMatches,
  safeEqual,
  sha256Hex,
} from "../lib/grant/cf-grant";

/**
 * Install handoff (same contract as Dotnote's `/api/install/*`). No owner
 * session: these are guarded by the setup code whose SHA-256 the installer
 * put on the Worker as `RELAYBASE_HANDOFF`, or by a one-time reconnect code
 * the signed-in owner asked for (`/console/cloudflare/reconnect-code`).
 */
const install = new Hono<{ Bindings: Env }>();

/** Proves this is the Worker the installer just deployed: HMAC of the nonce with the handoff hash. */
install.post("/prove", async (c) => {
  const secret = c.env.RELAYBASE_HANDOFF;
  if (!secret) return c.json({ error: "not_installing" }, 404);
  let nonce = "";
  try {
    nonce = String(((await c.req.json()) as { nonce?: unknown }).nonce ?? "");
  } catch {
    /* empty */
  }
  if (nonce.length < 8 || nonce.length > 200) return c.json({ error: "invalid_nonce" }, 400);
  return c.json({ mac: await hmacHex(secret, nonce) });
});

type HandoffBody = { code?: unknown; refreshToken?: unknown; accountId?: unknown; scopes?: unknown };

function field(value: unknown, min: number, max: number): string | null {
  return typeof value === "string" && value.length >= min && value.length <= max ? value : null;
}

/** Receives the Cloudflare refresh token once and keeps it (rotated, encrypted). */
install.post("/handoff", async (c) => {
  let body: HandoffBody;
  try {
    body = (await c.req.json()) as HandoffBody;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const code = field(body.code, 16, 200);
  const refreshToken = field(body.refreshToken, 10, 8000);
  const accountId = field(body.accountId, 1, 64);
  const scopes = field(body.scopes, 1, 4000);
  if (!code || !refreshToken || !accountId || !scopes) return c.json({ error: "Invalid handoff" }, 400);

  const installOk = !!c.env.RELAYBASE_HANDOFF && safeEqual(await sha256Hex(code), c.env.RELAYBASE_HANDOFF);
  let reconnectOk = false;
  try {
    reconnectOk = await reconnectCodeMatches(c.env, code);
  } catch {
    reconnectOk = false;
  }
  if (!installOk && !reconnectOk) return c.json({ error: "This setup code was not accepted." }, 403);
  // A used setup code hands over again only while there is no grant to keep.
  if (installOk && !reconnectOk && (await handoffConsumed(c.env)) && (await grantReadable(c.env))) {
    return c.json({ ok: true, already: true });
  }

  try {
    await acceptRefreshToken(c.env, { refreshToken, accountId, scopes });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Cloudflare did not accept the permission." }, 400);
  }

  if (reconnectOk) await consumeReconnectCode(c.env, code);
  else await markHandoffConsumed(c.env);
  return c.json({ ok: true });
});

export { install };
