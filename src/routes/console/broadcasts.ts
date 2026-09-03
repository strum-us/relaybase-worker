import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { cloudflareSendErrorBody } from "../../lib/cloudflare-api-hints";
import { createAppDb } from "../../../db/app";
import {
  createBroadcastDraft,
  getBroadcastDetail,
  getBroadcastProgress,
  readBroadcasts,
  sendBroadcast,
  updateBroadcastDraft,
} from "../../lib/catalog-broadcasts";

const consoleBroadcasts = new Hono<{ Bindings: Env }>();

consoleBroadcasts.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const broadcasts = await readBroadcasts(createAppDb(c.env.RELAYBASE_DB));
  const domain = c.req.query("domain")?.trim().toLowerCase();
  const filtered = domain
    ? broadcasts.filter((b) => b.domain === domain)
    : broadcasts;
  return c.json({ broadcasts: filtered });
});

consoleBroadcasts.post("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  let body: {
    id?: string;
    groupIds?: string[];
    from?: string;
    subject?: string;
    body?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const broadcast = await createBroadcastDraft(createAppDb(c.env.RELAYBASE_DB), {
      id: body.id,
      groupIds: body.groupIds ?? [],
      from: body.from,
      subject: body.subject,
      body: body.body,
    });
    return c.json({ broadcast }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return c.json({ error: message }, 400);
  }
});

consoleBroadcasts.get("/:broadcastId", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const detail = await getBroadcastDetail(
    createAppDb(c.env.RELAYBASE_DB),
    c.req.param("broadcastId"),
  );
  if (!detail) return c.json({ error: "Broadcast not found" }, 404);
  return c.json(detail);
});

consoleBroadcasts.patch("/:broadcastId", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  let body: {
    groupIds?: string[];
    from?: string | null;
    subject?: string;
    body?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const broadcast = await updateBroadcastDraft(
      createAppDb(c.env.RELAYBASE_DB),
      c.req.param("broadcastId"),
      body,
    );
    return c.json({ broadcast });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return c.json({ error: message }, 400);
  }
});

consoleBroadcasts.post("/:broadcastId/send", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  let body: { from?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body ok
  }
  try {
    const broadcast = await sendBroadcast(
      c.env,
      c.req.param("broadcastId"),
      body,
    );
    return c.json({ broadcast });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    const body = cloudflareSendErrorBody(message);
    return c.json(body, body.code ? 403 : 400);
  }
});

consoleBroadcasts.get("/:broadcastId/progress", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const broadcasts = await readBroadcasts(createAppDb(c.env.RELAYBASE_DB));
  const broadcast = broadcasts.find(
    (b) => b.id === c.req.param("broadcastId"),
  );
  if (!broadcast) return c.json({ error: "Broadcast not found" }, 404);
  return c.json(getBroadcastProgress(broadcast));
});

export { consoleBroadcasts };
