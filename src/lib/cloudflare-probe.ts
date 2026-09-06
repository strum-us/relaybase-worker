const CF_API = "https://api.cloudflare.com/client/v4";

async function probeEditPermission(url: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    // 401 Unauthorized or 403 Forbidden indicates missing or insufficient permissions
    if (res.status === 401 || res.status === 403) {
      return false;
    }

    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      errors?: Array<{ code?: number; message?: string }>;
    } | null;

    if (data?.errors && Array.isArray(data.errors)) {
      for (const err of data.errors) {
        if (err.code === 9109 || err.code === 10000 || err.code === 10001) {
          return false;
        }
        if (
          typeof err.message === "string" &&
          /unauthorized|permission|forbidden|authentication/i.test(err.message)
        ) {
          return false;
        }
      }
    }

    // HTTP 400 / 422 indicates payload validation failed AFTER passing authorization (i.e. Edit permission is present)
    if (res.status === 400 || res.status === 422 || res.ok) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Proves that CF_API_TOKEN has required permissions:
 * 1. Zone Read (GET /zones?per_page=1)
 * 2. If at least one zone exists:
 *    - Email Routing Rules Edit (POST /zones/{id}/email/routing/rules)
 *    - DNS Edit (POST /zones/{id}/dns_records)
 */
export async function probeCfApiTokenValid(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${CF_API}/zones?per_page=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      result?: Array<{ id: string }>;
    } | null;
    if (data?.success !== true) return false;

    const firstZone = data.result?.[0]?.id;
    if (firstZone) {
      const [routingOk, dnsOk] = await Promise.all([
        probeEditPermission(`${CF_API}/zones/${firstZone}/email/routing/rules`, token),
        probeEditPermission(`${CF_API}/zones/${firstZone}/dns_records`, token),
      ]);

      if (!routingOk || !dnsOk) return false;
    }

    return true;
  } catch {
    return false;
  }
}
