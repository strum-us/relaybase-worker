import type { Context, MiddlewareHandler } from "hono";

import type { Env } from "../env";

/**
 * Origins allowed to call Worker admin/API routes from a browser.
 * Packaged Tauri uses `https://tauri.localhost` (or `tauri://localhost`).
 */
function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (
    origin === "https://relaybase.xyz" ||
    origin === "https://www.relaybase.xyz"
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
    "Authorization, Content-Type, Accept",
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
