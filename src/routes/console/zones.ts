import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth/auth";
import {
  CLOUDFLARE_NOT_CONNECTED_MESSAGE,
  createCloudflareClient,
} from "../../lib/cloudflare/cloudflare-config";

const consoleZones = new Hono<{ Bindings: Env }>();

/** List Cloudflare zones on the pinned Worker account (stored Cloudflare OAuth grant). */
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
            : CLOUDFLARE_NOT_CONNECTED_MESSAGE,
      },
      503,
    );
  }

  try {
    const zones = await cf.listZones();
    return c.json({
      zones: zones.map((zone) => ({
        id: zone.id,
        name: zone.name,
        status: zone.status,
        accountId: zone.accountId,
        nameServers: zone.nameServers,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list zones";
    return c.json({ error: message }, 502);
  }
});

export { consoleZones };
