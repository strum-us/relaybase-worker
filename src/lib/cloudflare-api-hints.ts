/** Relaybase API code when Cloudflare Email Sending requires Workers Paid. */
export const CF_WORKERS_PAID_REQUIRED_CODE = "cf_workers_paid_required";

/**
 * Free accounts often get zone Email Sending APIs as [2036] Unauthorized
 * instead of Email Sending’s [10105] not_entitled.
 */
function messageLooksLikePlanError(message: string): boolean {
  const lower = message.toLowerCase();
  if (
    lower.includes("[10105]") ||
    lower.includes("not_entitled") ||
    lower.includes("not entitled") ||
    lower.includes("workers paid") ||
    lower.includes("paid plan")
  ) {
    return true;
  }
  // Zone Email Sending list/create on Workers Free.
  if (
    lower.includes("[2036]") &&
    lower.includes("unauthorized") &&
    lower.includes("email/sending")
  ) {
    return true;
  }
  return false;
}

/** True when Cloudflare rejected send because the account lacks Workers Paid. */
export function isCloudflarePlanError(
  input: string | Array<{ code?: number; message?: string }> | undefined,
): boolean {
  if (!input) return false;
  if (Array.isArray(input)) {
    const code = input[0]?.code;
    const msg = input[0]?.message ?? "";
    if (code === 10105) return true;
    if (code === 2036 && /unauthorized/i.test(msg)) return true;
    return messageLooksLikePlanError(msg);
  }
  return messageLooksLikePlanError(input);
}

/** JSON body for send failures; adds `code` when the failure is plan-related. */
export function cloudflareSendErrorBody(message: string): {
  error: string;
  code?: string;
} {
  if (isCloudflarePlanError(message)) {
    return {
      error:
        "Sending requires a Cloudflare Workers Paid plan (~$5/mo, billed by Cloudflare).",
      code: CF_WORKERS_PAID_REQUIRED_CODE,
    };
  }
  return { error: message };
}

/** Human-readable permission hints for Cloudflare API auth failures (code 10000). */
export function cloudflarePermissionHint(
  path: string,
  method = "GET",
): string | null {
  const m = method.toUpperCase();
  const p = path.split("?")[0] ?? path;

  if (p.includes("/email/sending/send")) {
    return [
      `Endpoint: ${m} /accounts/{{account_id}}/email/sending/send`,
      "Required: Account → Email Sending → Edit",
      "The From domain must be onboarded in Cloudflare → Email Service → Email Sending.",
      "Before onboarding, you can only send to verified destination addresses.",
    ].join("\n");
  }

  if (p.includes("/email/routing/enable")) {
    return [
      `Endpoint: ${m} /zones/{{zone_id}}/email/routing/enable`,
      "Required: Zone → Zone Settings → Edit",
    ].join("\n");
  }

  if (p.includes("/email/routing/rules")) {
    return [
      `Endpoint: ${m} /zones/{{zone_id}}/email/routing/rules`,
      "Required: Zone → Email Routing Rules → Edit",
    ].join("\n");
  }

  if (p.includes("/zones") && !p.includes("/email/")) {
    return [
      `Endpoint: ${m} /zones`,
      "Required: Zone → Zone → Read",
    ].join("\n");
  }

  return null;
}

/** Hints for Email Sending API errors (non-auth). */
export function cloudflareSendingErrorHint(
  errors?: Array<{ code?: number; message?: string }>,
): string | null {
  const code = errors?.[0]?.code;
  const msg = errors?.[0]?.message ?? "";

  if (code === 10002 || msg.includes("internal_server")) {
    return [
      "Cloudflare returned an internal sending error (10002). Common causes:",
      "• The From domain is not onboarded in Cloudflare Email Sending",
      "• Sending DNS records are missing or not verified yet",
      "• API token needs Account → Email Sending → Edit",
      "• Before the domain is fully enabled, send only to verified destination addresses",
      "Retry after fixing setup; if it persists, check Cloudflare status or support.",
    ].join("\n");
  }

  if (code === 10203 || msg.includes("sending_disabled")) {
    return "Email Sending is disabled for this domain or account. Onboard the domain in Cloudflare Email Sending and verify DNS records.";
  }

  if (code === 10105 || msg.includes("not_entitled")) {
    return "This Cloudflare account is not entitled to Email Sending. Enroll in Email Service in the Cloudflare dashboard.";
  }

  if (
    code === 2036 ||
    (msg.toLowerCase().includes("unauthorized") && msg.includes("[2036]"))
  ) {
    return "Sending requires a Cloudflare Workers Paid plan (~$5/mo, billed by Cloudflare).";
  }

  if (code === 10102 || code === 10103 || msg.includes("forbidden")) {
    return "API token lacks permission. Verify Zone and Routing permissions for this token.";
  }

  if (code === 10100 || msg.includes("upstream")) {
    return "Cloudflare authentication service is temporarily unavailable. Retry in a few minutes.";
  }

  return null;
}
