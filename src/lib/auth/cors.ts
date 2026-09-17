import type { Context, MiddlewareHandler } from "hono";

import type { Env } from "../../env";

/**
 * Origins allowed to call Worker admin/API routes from a browser.
 * Packaged Tauri uses `https://tauri.localhost` (or `tauri://localhost`).
 */
function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (
    origin === "https://relaybase.xyz" ||
    origin === "https://www.relaybase.xyz" ||
    origin === "https://relaybase.email" ||
    origin === "https://www.relaybase.email"
  ) {
    return true;
  }
  if (origin === "null") return true; // some asset:// / file-like webviews
  if (origin.startsWith("tauri://") || origin.startsWith("asset://")) {
    return true;
  }
  if (origin.startsWith("capacitor://") || origin.startsWith("http://")) {
    // Capacitor (iOS) and local web debug for the Flutter app.
    return true;
  }
  try {
    const u = new URL(origin);
    if (u.hostname === "tauri.localhost" || u.hostname.endsWith(".tauri.localhost")) {
      return true;
    }
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      return true;
    }
    // HQ-hosted team web mail (OpenNext on Workers) and other *.workers.dev previews.
    if (u.hostname === "workers.dev" || u.hostname.endsWith(".workers.dev")) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function applyCorsHeaders(
  c: Context<{ Bindings: Env }>,
  origin: string | undefined,
) {
  if (origin && isAllowedOrigin(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
  c.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  c.header(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, X-Account-Email, X-Relaybase-Retried",
  );
  c.header("Access-Control-Max-Age", "86400");
}

/** CORS for packaged desktop + local Next → Worker browser fetches. */
export const desktopCors: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  const origin = c.req.header("Origin");
  if (c.req.method === "OPTIONS") {
    applyCorsHeaders(c, origin);
    return c.body(null, 204);
  }
  await next();
  applyCorsHeaders(c, origin);
};
