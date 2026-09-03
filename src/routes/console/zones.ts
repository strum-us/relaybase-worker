import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { createCloudflareClient } from "../../lib/cloudflare-config";

const consoleZones = new Hono<{ Bindings: Env }>();

/** List Cloudflare zones on the pinned Worker account (`CF_API_TOKEN`). */
consoleZones.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  let cf;
  try {
    cf = await createCloudflareClient(c.env, {
      accountId: c.req.query("accountId"),
    });
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Cloudflare API is not configured on this worker — add a CF_API_TOKEN secret (Email Routing + Zone Read + DNS) so the Worker can manage domains and DNS",
      },
      503,
    );
  }

  try {
    const zones = await cf.listZones();
    return c.json({ zones });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list zones";
    return c.json({ error: message }, 502);
  }
});

export { consoleZones };
