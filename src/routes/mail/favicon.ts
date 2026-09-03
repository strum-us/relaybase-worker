import { Hono } from "hono";
import type { Env } from "../../env";
import { requireMailSession } from "../../lib/auth";

const mailFavicon = new Hono<{ Bindings: Env }>();

const FETCH_TIMEOUT_MS = 5_000;
/** Anything bigger than this is not a favicon — bail to keep memory bounded. */
const MAX_ICON_BYTES = 256 * 1024;

/** Paths probed in order until one returns a usable image. */
const ICON_PATHS = ["/favicon.ico", "/apple-touch-icon.png", "/favicon.svg"];

function sanitizeDomain(raw: string | undefined): string | null {
  const domain = (raw ?? "").trim().toLowerCase();
  if (!domain || !domain.includes(".")) return null;
  // Hostname characters only — reject anything that could smuggle a path/port.
  if (!/^[a-z0-9.-]+$/.test(domain)) return null;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) {
    return null;
  }
  return domain;
}

function iconContentType(res: Response, path: string): string | null {
  const type = res.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (type?.startsWith("image/")) return type;
  // Many sites serve .ico without a proper content type.
  if (path.endsWith(".ico") && (!type || type === "application/octet-stream")) {
    return "image/x-icon";
  }
  if (path.endsWith(".svg") && type === "text/xml") return "image/svg+xml";
  return null;
}

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchIcon(domain: string, path: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${domain}${path}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "image/*" },
    });
    if (!res.ok) return null;
    const contentType = iconContentType(res, path);
    if (!contentType) return null;
    const declaredLength = Number(res.headers.get("Content-Length") ?? "0");
    if (declaredLength > MAX_ICON_BYTES) return null;
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) return null;
    return `data:${contentType};base64,${toBase64(bytes)}`;
  } catch {
    return null;
  }
}

// Proxy sender-domain favicons for the desktop inbox avatar cache. Direct
// browser <img> loads work, but a JSON data-URL response lets the client keep
// one in-memory copy per domain (and CORS never blocks the read).
mailFavicon.get("/", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  const domain = sanitizeDomain(c.req.query("domain"));
  if (!domain) {
    return c.json({ error: "domain query parameter is required" }, 400);
  }

  let dataUrl: string | null = null;
  for (const path of ICON_PATHS) {
    dataUrl = await fetchIcon(domain, path);
    if (dataUrl) break;
  }

  c.header("Cache-Control", "private, max-age=86400");
  return c.json({ domain, dataUrl });
});

export { mailFavicon };
