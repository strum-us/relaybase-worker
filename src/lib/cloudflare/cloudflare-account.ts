import { normalizeCfAccountId } from "./cf-account-id.ts";

const CF_API = "https://api.cloudflare.com/client/v4";

/**
 * Account id only when the token can see exactly one Cloudflare account.
 * Never take a zone's account.id from GET /zones — that list is every
 * account the token can read.
 */
export async function resolveCfAccountIdFromToken(
  token: string,
): Promise<string | null> {
  const bearer = token.trim();
  if (!bearer) return null;
  try {
    const res = await fetch(`${CF_API}/accounts?per_page=50`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    const data = (await res.json()) as {
      success?: boolean;
      result?: Array<{ id?: string }>;
    };
    if (!data.success || !Array.isArray(data.result)) return null;
    const ids = [
      ...new Set(
        data.result
          .map((row) => normalizeCfAccountId(row.id))
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    return ids.length === 1 ? ids[0]! : null;
  } catch {
    return null;
  }
}
