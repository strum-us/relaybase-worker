import type { Env } from "../env";
import { createAppDb } from "../../db/app";
import {
  createOwnerSession,
  deleteAllOwnerSessions,
  deleteOwnerSession,
  deleteOwnerSessionByHash,
  deleteOwnerSessionsByFamily,
  findOwnerSessionByHash,
} from "../../db/app/owner-sessions";
import {
  getOwnerLoginConfig,
  ownerIsConfigured,
  setOwnerLogin,
  setOwnerCfAccountId,
} from "../../db/app/owner";
import { sha256Hex } from "./crypto";
import { normalizeCfAccountId } from "./cf-account-id.ts";
import {
  CONSOLE_ACCESS_TTL_SECONDS,
  CONSOLE_REFRESH_TTL_SECONDS,
  generatePasstoken,
  generateRefreshToken,
  hashPasstoken,
  isValidPasstokenFormat,
  MAIL_ACCESS_TTL_SECONDS,
  MAIL_REFRESH_TTL_SECONDS,
  passtokenPrefix,
  randomSalt,
  scopeFromSessionLabel,
  sessionLabelForScope,
  signAccessToken,
  type AccessPayload,
  type OwnerScope,
} from "./owner-tokens";

export {
  ACCESS_TTL_SECONDS,
  CONSOLE_ACCESS_TTL_SECONDS,
  CONSOLE_REFRESH_TTL_SECONDS,
  MAIL_ACCESS_TTL_SECONDS,
  MAIL_REFRESH_TTL_SECONDS,
  generatePasstoken,
  passtokenPrefix,
  isValidPasstokenFormat,
  signAccessToken,
  verifyAccessToken,
} from "./owner-tokens";
export type { AccessPayload, OwnerScope } from "./owner-tokens";

/** HTTP status codes returned by owner-auth helpers. */
type AuthStatus = 400 | 401 | 403 | 409 | 503;
type AuthError = { error: string; status: AuthStatus };

export type OwnerRefreshResult = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: OwnerScope;
};

/** Passtoken login — mail access immediately; console refresh for later gate. */
export type OwnerLoginResult = {
  mailAccessToken: string;
  mailRefreshToken: string;
  consoleRefreshToken: string;
  mailExpiresIn: number;
};

const OWNER_SUB = "owner";

function accessTtlForScope(scope: OwnerScope): number {
  return scope === "mail" ? MAIL_ACCESS_TTL_SECONDS : CONSOLE_ACCESS_TTL_SECONDS;
}

function refreshTtlForScope(scope: OwnerScope): number {
  return scope === "mail" ? MAIL_REFRESH_TTL_SECONDS : CONSOLE_REFRESH_TTL_SECONDS;
}

function requirePepper(env: Env): string | AuthError {
  const pepper = env.AUTH_PEPPER?.trim() ?? "";
  if (!pepper) {
    return {
      error: "Worker is missing AUTH_PEPPER. Re-run Setup so the install can set it.",
      status: 503,
    };
  }
  return pepper;
}

async function mintScopedAccess(
  pepper: string,
  scope: OwnerScope,
): Promise<{ accessToken: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = accessTtlForScope(scope);
  const accessPayload: AccessPayload = {
    sub: OWNER_SUB,
    iat: now,
    exp: now + expiresIn,
    jti: crypto.randomUUID(),
    scope,
  };
  const accessToken = await signAccessToken(pepper, accessPayload);
  return { accessToken, expiresIn };
}

async function createScopedRefreshSession(
  db: NonNullable<ReturnType<typeof createAppDb>>,
  scope: OwnerScope,
  label: string | null,
): Promise<string> {
  const refreshToken = generateRefreshToken();
  const refreshHash = await sha256Hex(refreshToken);
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + refreshTtlForScope(scope) * 1000,
  ).toISOString();
  const deviceLabel = label?.trim() || "desktop";
  await createOwnerSession(db, {
    id: crypto.randomUUID(),
    tokenHash: refreshHash,
    family: crypto.randomUUID(),
    label: sessionLabelForScope(scope, deviceLabel),
    expiresAt,
  });
  return refreshToken;
}

// ─── setup-admin (first owner) ────────────────────────────────────────────

export type SetupAdminInput = {
  pepper: string;
};

export type SetupAdminResult = {
  passtoken: string;
};

/** Issues the first owner passtoken. Only allowed when no owner exists yet. */
export async function setupOwner(
  env: Env,
  input: SetupAdminInput,
): Promise<{ result: SetupAdminResult } | AuthError> {
  const db = createAppDb(env.RELAYBASE_DB);
  if (!db) return { error: "Database not configured", status: 503 };

  const pepperOrErr = requirePepper(env);
  if (typeof pepperOrErr !== "string") return pepperOrErr;
  const pepper = pepperOrErr;
  if (pepper !== input.pepper.trim()) {
    return { error: "Unauthorized", status: 401 };
  }

  const salt = randomSalt();
  const passtoken = generatePasstoken();
  const hash = await hashPasstoken(pepper, salt, passtoken);
  await setOwnerLogin(db, {
    passtokenSalt: salt,
    passtokenHash: hash,
    passtokenPrefix: passtokenPrefix(passtoken),
  });
  await deleteAllOwnerSessions(db);
  return { result: { passtoken } };
}

// ─── login ────────────────────────────────────────────────────────────────

export async function loginOwner(
  env: Env,
  input: { passtoken: string; label?: string | null },
): Promise<{ result: OwnerLoginResult } | AuthError> {
  const db = createAppDb(env.RELAYBASE_DB);
  if (!db) return { error: "Database not configured", status: 503 };
  const pepperOrErr = requirePepper(env);
  if (typeof pepperOrErr !== "string") return pepperOrErr;
  const pepper = pepperOrErr;

  const cfg = await getOwnerLoginConfig(db);
  if (!cfg || !cfg.passtokenHash || !cfg.passtokenSalt) {
    return { error: "Invalid credentials", status: 401 };
  }

  const passtokenOk =
    isValidPasstokenFormat(input.passtoken) &&
    (await hashPasstoken(pepper, cfg.passtokenSalt, input.passtoken)) ===
      cfg.passtokenHash;

  if (!passtokenOk) {
    return { error: "Invalid credentials", status: 401 };
  }

  const mailRefreshToken = await createScopedRefreshSession(
    db,
    "mail",
    input.label ?? null,
  );
  const consoleRefreshToken = await createScopedRefreshSession(
    db,
    "console",
    input.label ?? null,
  );
  const { accessToken: mailAccessToken, expiresIn: mailExpiresIn } =
    await mintScopedAccess(pepper, "mail");

  return {
    result: {
      mailAccessToken,
      mailRefreshToken,
      consoleRefreshToken,
      mailExpiresIn,
    },
  };
}

// ─── refresh ──────────────────────────────────────────────────────────────

export async function refreshOwner(
  env: Env,
  refreshToken: string,
  scope: OwnerScope,
): Promise<{ result: OwnerRefreshResult } | AuthError> {
  const db = createAppDb(env.RELAYBASE_DB);
  if (!db) return { error: "Database not configured", status: 503 };
  const pepperOrErr = requirePepper(env);
  if (typeof pepperOrErr !== "string") return pepperOrErr;
  const pepper = pepperOrErr;

  const hash = await sha256Hex(refreshToken.trim());
  const session = await findOwnerSessionByHash(db, hash);
  if (!session) {
    return { error: "Unauthorized", status: 401 };
  }
  const sessionScope = scopeFromSessionLabel(session.label);
  if (sessionScope !== null && sessionScope !== scope) {
    return { error: "Unauthorized", status: 401 };
  }
  if (Date.parse(session.expiresAt) <= Date.now()) {
    await deleteOwnerSession(db, session.id);
    return { error: "Unauthorized", status: 401 };
  }

  await deleteOwnerSession(db, session.id);

  const cfg = await getOwnerLoginConfig(db);
  if (!cfg?.passtokenHash) {
    return { error: "Unauthorized", status: 401 };
  }

  const newRefresh = generateRefreshToken();
  const newHash = await sha256Hex(newRefresh);
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + refreshTtlForScope(scope) * 1000,
  ).toISOString();
  const label =
    sessionScope !== null
      ? session.label
      : sessionLabelForScope(scope, session.label ?? "desktop");
  await createOwnerSession(db, {
    id: crypto.randomUUID(),
    tokenHash: newHash,
    family: session.family,
    label,
    expiresAt,
  });

  const { accessToken, expiresIn } = await mintScopedAccess(pepper, scope);

  return {
    result: {
      accessToken,
      refreshToken: newRefresh,
      expiresIn,
      scope,
    },
  };
}

/** Revoke the family that owns a refresh token (reuse / explicit revoke). */
export async function revokeOwnerFamilyByRefresh(
  env: Env,
  refreshToken: string,
): Promise<void> {
  const db = createAppDb(env.RELAYBASE_DB);
  if (!db) return;
  const hash = await sha256Hex(refreshToken.trim());
  const session = await findOwnerSessionByHash(db, hash);
  if (session) await deleteOwnerSessionsByFamily(db, session.family);
}

// ─── logout ───────────────────────────────────────────────────────────────

export async function logoutOwner(env: Env, refreshToken: string): Promise<void> {
  const db = createAppDb(env.RELAYBASE_DB);
  if (!db) return;
  const hash = await sha256Hex(refreshToken.trim());
  await deleteOwnerSessionByHash(db, hash);
}

// ─── rotate passtoken (logged-in owner) ───────────────────────────────────

export async function rotatePasstoken(
  env: Env,
): Promise<{ passtoken: string } | AuthError> {
  const db = createAppDb(env.RELAYBASE_DB);
  if (!db) return { error: "Database not configured", status: 503 };
  const pepperOrErr = requirePepper(env);
  if (typeof pepperOrErr !== "string") return pepperOrErr;
  const pepper = pepperOrErr;
  const cfg = await getOwnerLoginConfig(db);
  if (!cfg?.passtokenHash) return { error: "Unauthorized", status: 401 };

  const salt = randomSalt();
  const passtoken = generatePasstoken();
  const hash = await hashPasstoken(pepper, salt, passtoken);
  await setOwnerLogin(db, {
    passtokenSalt: salt,
    passtokenHash: hash,
    passtokenPrefix: passtokenPrefix(passtoken),
  });
  await deleteAllOwnerSessions(db);
  return { passtoken };
}

export { normalizeCfAccountId };

// ─── reset-admin (forgot passtoken, CF OAuth proof) ─────────────────────

export async function resetOwner(
  env: Env,
  input: { cfAccessToken: string; cfAccountId?: string },
): Promise<{ passtoken: string } | AuthError> {
  const db = createAppDb(env.RELAYBASE_DB);
  if (!db) return { error: "Database not configured", status: 503 };
  const pepperOrErr = requirePepper(env);
  if (typeof pepperOrErr !== "string") return pepperOrErr;
  const pepper = pepperOrErr;
  const fromEnv = normalizeCfAccountId(env.CF_ACCOUNT_ID) ?? "";
  const fromBody = normalizeCfAccountId(input.cfAccountId) ?? "";
  if (fromEnv && fromBody && fromEnv !== fromBody) {
    return { error: "Unauthorized", status: 401 };
  }
  let expectedAccount = fromEnv || fromBody;
  if (!expectedAccount) {
    expectedAccount = (await discoverRecoverAccount(input.cfAccessToken)) ?? "";
  }
  if (!expectedAccount) {
    return {
      error:
        "Could not verify which Cloudflare account authorized this token. Try Authorize again.",
      status: 401,
    };
  }

  const verified = await verifyCfTokenForReset(
    input.cfAccessToken,
    expectedAccount,
  );
  if (!verified.ok) return { error: "Unauthorized", status: 401 };

  const salt = randomSalt();
  const passtoken = generatePasstoken();
  const hash = await hashPasstoken(pepper, salt, passtoken);
  await setOwnerLogin(db, {
    passtokenSalt: salt,
    passtokenHash: hash,
    passtokenPrefix: passtokenPrefix(passtoken),
  });
  try {
    await setOwnerCfAccountId(db, expectedAccount);
  } catch (err) {
    console.warn("Could not persist cf_account_id on owner_config", err);
  }
  await deleteAllOwnerSessions(db);
  return { passtoken };
}

/** Prove a Cloudflare OAuth access token can see `expectedAccount`. */
export async function verifyCfTokenAccount(
  token: string,
  expectedAccount: string,
): Promise<{ ok: boolean; accountId?: string }> {
  const bearer = token.trim();
  const expected = expectedAccount.trim();
  if (!bearer || !expected) return { ok: false };
  try {
    const accRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(expected)}`,
      { headers: { Authorization: `Bearer ${bearer}` } },
    );
    const accData = (await accRes.json()) as {
      success?: boolean;
      result?: { id?: string };
    };
    const id = accData.result?.id?.trim() ?? "";
    if (!accData.success || id !== expected) return { ok: false };
    return { ok: true, accountId: expected };
  } catch {
    return { ok: false };
  }
}

/**
 * Prove a Cloudflare OAuth access token can list Secrets Store on
 * `expectedAccount` (`secrets-store.write`). Used by forgot-passtoken
 * reset — that OAuth client has only this scope.
 */
export async function verifyCfTokenSecretsStore(
  token: string,
  expectedAccount: string,
): Promise<{ ok: boolean; accountId?: string }> {
  const bearer = token.trim();
  const expected = expectedAccount.trim();
  if (!bearer || !expected) return { ok: false };
  try {
    const storeRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(expected)}/secrets_store/stores?per_page=1`,
      { headers: { Authorization: `Bearer ${bearer}` } },
    );
    const storeData = (await storeRes.json()) as { success?: boolean };
    if (!storeData.success) return { ok: false };
    return { ok: true, accountId: expected };
  } catch {
    return { ok: false };
  }
}

/**
 * Forgot-passtoken proof: Secrets Store list on the pinned CF account, then
 * GET `/accounts/{id}` so an in-memory install token still works.
 */
export async function verifyCfTokenForReset(
  token: string,
  expectedAccount: string,
): Promise<{ ok: boolean; accountId?: string }> {
  const store = await verifyCfTokenSecretsStore(token, expectedAccount);
  if (store.ok) return store;
  return verifyCfTokenAccount(token, expectedAccount);
}

/** List accessible accounts and pick one the recover token can use for Secrets Store. */
export async function discoverRecoverAccount(
  token: string,
): Promise<string | null> {
  const bearer = token.trim();
  if (!bearer) return null;
  try {
    const res = await fetch(
      "https://api.cloudflare.com/client/v4/accounts?per_page=50",
      { headers: { Authorization: `Bearer ${bearer}` } },
    );
    const data = (await res.json()) as {
      success?: boolean;
      result?: Array<{ id?: string }>;
    };
    if (!data.success || !Array.isArray(data.result)) return null;
    for (const row of data.result) {
      const id = row.id?.trim() ?? "";
      if (!id) continue;
      const ok = await verifyCfTokenSecretsStore(bearer, id);
      if (ok.ok) return id;
    }
  } catch {
    return null;
  }
  return null;
}
