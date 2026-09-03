import { Hono } from "hono";
import type { Env } from "../../env";
import { createAppDb } from "../../../db/app";
import { getOwnerLoginConfig } from "../../../db/app/owner";
import {
  loginOwner,
  logoutOwner,
  normalizeCfAccountId,
  refreshOwner,
  resetOwner,
  rotatePasstoken,
  setupOwner,
} from "../../lib/owner-auth";
import {
  requireConsoleSession,
  requirePepperBootstrap,
} from "../../lib/auth";

const consoleOwnerAuth = new Hono<{ Bindings: Env }>();

/**
 * POST /console/setup-admin
 *
 * First-time owner setup. Allowed only when no owner exists yet and the
 * caller proves knowledge of AUTH_PEPPER (X-Auth-Pepper header, held in
 * desktop memory only during install). Returns the issued passtoken ONCE.
 */
consoleOwnerAuth.post("/setup-admin", async (c) => {
  const denied = await requirePepperBootstrap(c);
  if (denied) return denied;

  try {
    await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const result = await setupOwner(c.env, {
    pepper: c.req.header("X-Auth-Pepper") ?? "",
  });
  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json(
    {
      ok: true,
      passtoken: result.result.passtoken,
      message: "Copy this passtoken now. It will not be shown again.",
    },
    201,
  );
});

/**
 * POST /console/login
 *
 * Public. Body: { passtoken, label? }.
 * Returns { mailAccessToken, mailRefreshToken, consoleRefreshToken, mailExpiresIn }.
 */
consoleOwnerAuth.post("/login", async (c) => {
  let body: { passtoken?: string; label?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const result = await loginOwner(c.env, {
    passtoken: body.passtoken ?? "",
    label: body.label,
  });
  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json({ ok: true, ...result.result });
});

/**
 * POST /console/refresh
 *
 * Body: { refreshToken, scope: "mail" | "console" }. Rotates the refresh token;
 * returns a scoped access + refresh pair.
 */
consoleOwnerAuth.post("/refresh", async (c) => {
  let body: { refreshToken?: string; scope?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const refreshToken = body.refreshToken?.trim() ?? "";
  if (!refreshToken) return c.json({ error: "refreshToken is required" }, 400);
  const scopeRaw = body.scope?.trim() ?? "console";
  if (scopeRaw !== "mail" && scopeRaw !== "console") {
    return c.json({ error: "scope must be mail or console" }, 400);
  }
  const result = await refreshOwner(c.env, refreshToken, scopeRaw);
  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json({ ok: true, ...result.result });
});

/**
 * POST /console/logout
 *
 * Requires an owner session. Body: { refreshToken }.
 */
consoleOwnerAuth.post("/logout", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  let body: { refreshToken?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const refreshToken = body.refreshToken?.trim() ?? "";
  if (refreshToken) await logoutOwner(c.env, refreshToken);
  return c.json({ ok: true });
});

/**
 * POST /console/rotate-passtoken
 *
 * Requires an owner session. Issues a new passtoken (shown once) and
 * revokes every existing session.
 */
consoleOwnerAuth.post("/rotate-passtoken", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const result = await rotatePasstoken(c.env);
  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json({
    ok: true,
    passtoken: result.passtoken,
    message: "Copy this passtoken now. It will not be shown again.",
  });
});

/**
 * POST /console/reset-admin
 *
 * Forgot-passtoken recovery. Unauthenticated by design; security comes from
 * a Cloudflare OAuth access token (`cfAccessToken`) that can list Secrets
 * Store on this Worker's CF account (`CF_ACCOUNT_ID` secret or optional
 * `cfAccountId` body field). GET that account is an install-client fallback.
 * Issues a new passtoken (shown once) and revokes every existing session.
 */
consoleOwnerAuth.post("/reset-admin", async (c) => {
  let body: { cfAccessToken?: string; cfAccountId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const cfAccessToken = body.cfAccessToken?.trim() ?? "";
  if (!cfAccessToken) return c.json({ error: "cfAccessToken is required" }, 400);
  const result = await resetOwner(c.env, {
    cfAccessToken,
    cfAccountId: body.cfAccountId?.trim(),
  });
  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json({
    ok: true,
    passtoken: result.passtoken,
    message: "Copy this passtoken now. It will not be shown again.",
  });
});

/**
 * GET /console/auth-status
 *
 * Public probe used by the desktop to decide whether to show setup vs login.
 */
consoleOwnerAuth.get("/auth-status", async (c) => {
  const db = createAppDb(c.env.RELAYBASE_DB);
  const cfg = db ? await getOwnerLoginConfig(db) : null;
  const configured = Boolean(cfg?.passtokenHash);
  const fromEnv = normalizeCfAccountId(c.env.CF_ACCOUNT_ID);
  const fromDb = normalizeCfAccountId(cfg?.cfAccountId);
  return c.json({
    ok: true,
    ownerConfigured: configured,
    passtokenPrefix: cfg?.passtokenPrefix ?? null,
    cfAccountId: fromEnv ?? fromDb ?? null,
  });
});

export { consoleOwnerAuth };
