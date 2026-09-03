import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { listSendLogs } from "../../lib/send-logs";

const consoleSendLogs = new Hono<{ Bindings: Env }>();

consoleSendLogs.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  const limit = Number(c.req.query("limit") ?? "100");
  const status = c.req.query("status") ?? "all";
  const domain = c.req.query("domain")?.trim();

  if (!["all", "failed", "success"].includes(status)) {
    return c.json({ error: "status must be all, failed, or success" }, 400);
  }

  const result = await listSendLogs(c.env.INBOUND, {
    limit: Number.isFinite(limit) ? limit : 100,
    status: status as "all" | "failed" | "success",
    domain: domain || undefined,
  });

  return c.json({ ...result, workerConnected: true });
});

export { consoleSendLogs };
