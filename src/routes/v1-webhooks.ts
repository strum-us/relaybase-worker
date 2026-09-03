import { Hono } from "hono";
import type { Env } from "../env";
import { requireApiKey } from "../lib/auth";
import { createAppDb } from "../../db/app";
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
} from "../lib/webhooks";

const v1Webhooks = new Hono<{ Bindings: Env }>();

v1Webhooks.post("/", async (c) => {
  const auth = await requireApiKey(c);
  if (auth instanceof Response) return auth;

  let body: { url?: string; secret?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const url = body.url?.trim();
  if (!url) {
    return c.json({ error: "url is required" }, 400);
  }

  try {
    const result = await createWebhook(createAppDb(c.env.RELAYBASE_DB), {
      domain: auth.record.domain,
      url,
      secret: body.secret,
    });
    return c.json(
      {
        webhook: result.webhook,
        secret: result.secret,
      },
      201,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create webhook";
    return c.json({ error: message }, 400);
  }
});

v1Webhooks.get("/", async (c) => {
  const auth = await requireApiKey(c);
  if (auth instanceof Response) return auth;

  const webhooks = await listWebhooks(createAppDb(c.env.RELAYBASE_DB), auth.record.domain);
  return c.json({ webhooks });
});

v1Webhooks.delete("/:id", async (c) => {
  const auth = await requireApiKey(c);
  if (auth instanceof Response) return auth;

  const deleted = await deleteWebhook(
    createAppDb(c.env.RELAYBASE_DB),
    auth.record.domain,
    c.req.param("id"),
  );
  if (!deleted) {
    return c.json({ error: "Webhook not found" }, 404);
  }

  return c.json({ ok: true });
});

export { v1Webhooks };
