import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { probeD1Connection } from "../../lib/d1-status";
import { listOpsLogs } from "../../lib/ops-logs";

const consoleOpsLogs = new Hono<{ Bindings: Env }>();

consoleOpsLogs.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  const limit = Number(c.req.query("limit") ?? "100");
  const status = c.req.query("status") ?? "all";
  const domain = c.req.query("domain")?.trim();

  if (!["all", "failed", "success"].includes(status)) {
    return c.json({ error: "status must be all, failed, or success" }, 400);
  }

  const [result, d1] = await Promise.all([
    listOpsLogs(c.env.RELAYBASE_LOGS, {
      limit: Number.isFinite(limit) ? limit : 100,
      status: status as "all" | "failed" | "success",
      domain,
    }),
    probeD1Connection(
      c.env.RELAYBASE_LOGS,
      c.env.RELAYBASE_MAIL,
      c.env.RELAYBASE_DB,
      c.env.CF_ACCOUNT_ID,
      c.env.CF_API_TOKEN,
    ),
  ]);

  return c.json({
    ...result,
    workerConnected: true,
    d1Configured: d1.logs.configured,
  });
});

export { consoleOpsLogs };
