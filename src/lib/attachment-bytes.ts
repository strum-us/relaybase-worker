/** Decode a standard base64 string into bytes; returns null when not valid base64. */
export function decodeBase64String(value: string): ArrayBuffer | null {
  const trimmed = value.replace(/\s+/g, "");
  if (trimmed.length < 4 || trimmed.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  try {
    const binary = atob(trimmed);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  } catch {
    return null;
  }
}

const BASE64_ASCII_PREFIXES = [
  "iVBORw0KGgo", // PNG
  "/9j/", // JPEG
  "R0lGOD", // GIF
  "UklGR", // RIFF / WebP
  "JVBERi0", // PDF
  "UEsDB", // ZIP
];

function isAsciiBase64Payload(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false;
  const head = new TextDecoder("ascii").decode(
    bytes.subarray(0, Math.min(16, bytes.length)),
  );
  if (BASE64_ASCII_PREFIXES.some((prefix) => head.startsWith(prefix))) {
    return true;
  }
  const sampleLen = Math.min(bytes.length, 512);
  for (let i = 0; i < sampleLen; i++) {
    const c = bytes[i]!;
    const ok =
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x30 && c <= 0x39) ||
      c === 0x2b ||
      c === 0x2f ||
      c === 0x3d ||
      c === 0x0a ||
      c === 0x0d;
    if (!ok) return false;
  }
  return sampleLen >= 8;
}

/** Normalize attachment bytes from postal-mime or legacy R2 objects. */
export function normalizeAttachmentBytes(
  content: Uint8Array | ArrayBuffer | string,
): ArrayBuffer {
  if (typeof content === "string") {
    return decodeBase64String(content) ?? new TextEncoder().encode(content).buffer;
  }
  const bytes =
    content instanceof ArrayBuffer ? new Uint8Array(content) : content;
  if (isAsciiBase64Payload(bytes)) {
    const decoded = decodeBase64String(new TextDecoder("ascii").decode(bytes));
    if (decoded) return decoded;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
