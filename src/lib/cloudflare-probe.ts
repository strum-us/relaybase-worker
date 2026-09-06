const CF_API = "https://api.cloudflare.com/client/v4";

/**
 * Proves that CF_API_TOKEN has required permissions:
 * 1. Zone Read (GET /zones?per_page=1)
 * 2. If at least one zone exists:
 *    - Email Routing Rules (GET /zones/{id}/email/routing)
 *    - DNS (GET /zones/{id}/dns_records?per_page=1)
 */
export async function probeCfApiTokenValid(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${CF_API}/zones?per_page=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as {
      success?: boolean;
      result?: Array<{ id: string }>;
    };
    if (data.success !== true) return false;

    const firstZone = data.result?.[0]?.id;
    if (firstZone) {
      const [routingRes, dnsRes] = await Promise.all([
        fetch(`${CF_API}/zones/${firstZone}/email/routing`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${CF_API}/zones/${firstZone}/dns_records?per_page=1`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      if (!routingRes.ok) return false;
      const routingData = (await routingRes.json().catch(() => null)) as {
        success?: boolean;
      } | null;
      if (routingData?.success !== true) return false;

      if (!dnsRes.ok) return false;
      const dnsData = (await dnsRes.json().catch(() => null)) as {
        success?: boolean;
      } | null;
      if (dnsData?.success !== true) return false;
    }

    return true;
  } catch {
    return false;
  }
}
