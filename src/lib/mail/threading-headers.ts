/** RFC 5322 msg-id token, or null when it cannot be a threading header value. */
export function tokenToMessageId(raw: string): string | null {
  let token = raw.trim();
  if (!token) return null;
  if (
    token.startsWith("<") &&
    token.endsWith(">") &&
    !token.slice(1, -1).includes("<") &&
    !token.slice(1, -1).includes(">")
  ) {
    token = token.slice(1, -1).trim();
  }
  if (!token || /[\s<>\r\n]/.test(token) || !token.includes("@")) return null;
  const at = token.lastIndexOf("@");
  if (at <= 0 || at === token.length - 1) return null;
  const id = `<${token}>`;
  if (utf8Size(id) > 2048) return null;
  return id;
}

/** Wrap a Message-ID we generated or received for the message's own header. */
export function wrapMessageId(value: string): string {
  const trimmed = value.trim().replace(/[\r\n]+/g, "");
  if (!trimmed) return "";
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
  return `<${trimmed.replace(/^<|>$/g, "")}>`;
}

export type ThreadingHeaders = {
  inReplyTo?: string;
  references?: string;
  referencesCount: number;
  hasInReplyTo: boolean;
};

const MAX_REFERENCES = 100;
const MAX_HEADER_VALUE_BYTES = 2048;

/**
 * Normalize In-Reply-To / References the same way for the Email binding and
 * for stored MIME. Drops tokens that are not `<id@host>`, strips CR/LF, and
 * keeps the value inside Cloudflare's 2,048-byte header limit.
 */
export function buildThreadingHeaders(params: {
  inReplyTo?: string;
  references?: string;
}): ThreadingHeaders {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const id = tokenToMessageId(raw);
    if (!id) return;
    const key = id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ids.push(id);
  };

  for (const part of splitHeaderIds(params.references)) push(part);
  for (const part of splitHeaderIds(params.inReplyTo)) push(part);

  let refs = ids;
  if (refs.length > MAX_REFERENCES) {
    refs = refs.slice(refs.length - MAX_REFERENCES);
  }
  refs = fitHeaderValue(refs);

  const parent = lastValidId(params.inReplyTo);
  let inReplyTo =
    parent && refs.some((id) => id.toLowerCase() === parent.toLowerCase())
      ? parent
      : undefined;
  if (parent && !inReplyTo && utf8Size(parent) <= MAX_HEADER_VALUE_BYTES) {
    refs = fitHeaderValue([...refs, parent]);
    inReplyTo = refs.some((id) => id.toLowerCase() === parent.toLowerCase())
      ? parent
      : undefined;
  }

  return {
    inReplyTo,
    references: refs.length ? refs.join(" ") : undefined,
    referencesCount: refs.length,
    hasInReplyTo: Boolean(inReplyTo),
  };
}

export function threadingHeaderErrorCode(message: string): string | undefined {
  return message.match(/E_HEADER_[A-Z0-9_]+/)?.[0];
}

/** True when Cloudflare rejected the send because of a custom header. */
export function isThreadingHeaderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /E_HEADER_/i.test(message) ||
    /header ['"][^'"]+['"] is not allowed/i.test(message)
  );
}

function splitHeaderIds(value: string | undefined): string[] {
  if (!value) return [];
  // Only the first line is the header value. A CR/LF is a header break, not
  // another message id — folding/injection after it is discarded.
  const line = value.split(/\r\n|\n|\r/)[0] ?? "";
  return line.split(/[ \t]+/).filter(Boolean);
}

function lastValidId(value: string | undefined): string | undefined {
  const ids = splitHeaderIds(value)
    .map((part) => tokenToMessageId(part))
    .filter((id): id is string => Boolean(id));
  return ids[ids.length - 1];
}

function fitHeaderValue(ids: string[]): string[] {
  let next = ids;
  while (next.length > 1 && utf8Size(next.join(" ")) > MAX_HEADER_VALUE_BYTES) {
    next = next.slice(1);
  }
  if (next.length === 1 && utf8Size(next[0]!) > MAX_HEADER_VALUE_BYTES) return [];
  return next;
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
