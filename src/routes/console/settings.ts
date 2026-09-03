import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { createAppDb } from "../../../db/app";
import {
  getAppSettings,
  MIN_INBOUND_RETAIN_PER_DOMAIN,
  setInboundRetainPerDomain,
} from "../../../db/app/settings";

const consoleSettings = new Hono<{ Bindings: Env }>();

consoleSettings.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  const db = createAppDb(c.env.RELAYBASE_DB);
  if (!db) {
    return c.json({ error: "Product database is not configured" }, 503);
  }

  const settings = await getAppSettings(db);
  return c.json({ inboundRetainPerDomain: settings.inboundRetainPerDomain });
});

consoleSettings.put("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  const db = createAppDb(c.env.RELAYBASE_DB);
  if (!db) {
    return c.json({ error: "Product database is not configured" }, 503);
  }

  let body: { inboundRetainPerDomain?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!("inboundRetainPerDomain" in body)) {
    return c.json({ error: "inboundRetainPerDomain is required" }, 400);
  }

  const raw = body.inboundRetainPerDomain;
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      return c.json(
        { error: "inboundRetainPerDomain must be an integer or null" },
        400,
      );
    }
    if (raw < MIN_INBOUND_RETAIN_PER_DOMAIN) {
      return c.json(
        {
          error: `inboundRetainPerDomain must be at least ${MIN_INBOUND_RETAIN_PER_DOMAIN}, or null for unlimited`,
        },
        400,
      );
    }
  }

  const settings = await setInboundRetainPerDomain(
    db,
    raw === null || raw === undefined ? null : raw,
  );
  return c.json({ inboundRetainPerDomain: settings.inboundRetainPerDomain });
});

export { consoleSettings };
