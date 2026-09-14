const API_KEY_PREFIX = "rb_";
const LEGACY_API_KEY_PREFIX = "fes_";
const KEY_PREFIX_LENGTH = 8;

function stripApiKeyPrefix(apiKey: string): string {
  if (apiKey.startsWith(API_KEY_PREFIX)) {
    return apiKey.slice(API_KEY_PREFIX.length);
  }
  if (apiKey.startsWith(LEGACY_API_KEY_PREFIX)) {
    return apiKey.slice(LEGACY_API_KEY_PREFIX.length);
  }
  return apiKey;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(hash));
}

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${API_KEY_PREFIX}${bytesToBase64Url(bytes)}`;
}

export function keyPrefixFromApiKey(apiKey: string): string {
  return stripApiKeyPrefix(apiKey).slice(0, KEY_PREFIX_LENGTH);
}

export function isValidApiKeyFormat(apiKey: string): boolean {
  const hasKnownPrefix =
    apiKey.startsWith(API_KEY_PREFIX) ||
    apiKey.startsWith(LEGACY_API_KEY_PREFIX);
  if (!hasKnownPrefix) return false;
  return stripApiKeyPrefix(apiKey).length > KEY_PREFIX_LENGTH;
}

export function isValidDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  if (!d || d.includes("@") || d.includes("/") || d.includes(" ")) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d);
}

export function emailMatchesDomain(email: string, domain: string): boolean {
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedDomain = domain.trim().toLowerCase();
  return normalizedEmail.endsWith(`@${normalizedDomain}`);
}
