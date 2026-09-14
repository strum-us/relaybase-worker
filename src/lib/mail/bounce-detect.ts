/**
 * Lightweight bounce DSN detection + diagnostic extraction for Cloudflare
 * Email Routing/Sending bounces. Scans the raw MIME text so it works without
 * parsing the message into a full object twice.
 */

export type BounceDiagnostic = {
  finalRecipient?: string;
  diagnosticCode?: string;
  status?: string;
};

const CF_BOUNCE_FROM_RE = /^bounces@cf-bounce\./i;

export function isBounceMessage(
  raw: ArrayBuffer,
  fromEmail: string,
): boolean {
  if (CF_BOUNCE_FROM_RE.test(fromEmail)) return true;

  const text = new TextDecoder().decode(raw).slice(0, 4096).toLowerCase();
  return (
    text.includes("content-type: multipart/report") ||
    text.includes("content-type: message/delivery-status") ||
    text.includes("auto-submitted: auto-generated")
  );
}

function headerLineValue(
  text: string,
  headerName: string,
  maxOffset: number,
): string | undefined {
  const re = new RegExp(`^${headerName}\\s*:\\s*(.*)$`, "im");
  const searchArea = text.slice(0, maxOffset);
  const match = re.exec(searchArea);
  const value = match?.[1]?.trim();
  if (!value) return undefined;
  // Unfold continuation lines (simple).
  return value.replace(/\s+/g, " ").trim();
}

function stripAddressPrefix(value: string): string {
  // "rfc822; isaac@wedesk.so" -> "isaac@wedesk.so"
  const semi = value.indexOf(";");
  if (semi >= 0) return value.slice(semi + 1).trim();
  return value.trim();
}

export function parseBounceDiagnostic(
  raw: ArrayBuffer,
): BounceDiagnostic {
  const text = new TextDecoder().decode(raw);
  // DSN reports usually have the status part within the first ~8KB.
  const maxOffset = 8192;

  const finalRecipient = headerLineValue(text, "Final-Recipient", maxOffset);
  const diagnosticCode = headerLineValue(
    text,
    "Diagnostic-Code",
    maxOffset,
  );
  const status = headerLineValue(text, "Status", maxOffset);

  return {
    finalRecipient: finalRecipient
      ? stripAddressPrefix(finalRecipient)
      : undefined,
    diagnosticCode: diagnosticCode
      ? stripAddressPrefix(diagnosticCode)
      : undefined,
    status: status ? stripAddressPrefix(status) : undefined,
  };
}

export function buildBouncePreview(
  diagnostic: BounceDiagnostic,
  fallback = "Bounce: delivery failed",
): string {
  const parts: string[] = [];
  if (diagnostic.status) parts.push(`Status ${diagnostic.status}`);
  if (diagnostic.diagnosticCode) parts.push(diagnostic.diagnosticCode);
  if (diagnostic.finalRecipient) parts.push(`to ${diagnostic.finalRecipient}`);
  if (parts.length === 0) return fallback;
  return `Bounce: ${parts.join(" — ")}`;
}
