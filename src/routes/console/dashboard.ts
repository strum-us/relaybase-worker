import { Hono } from "hono";

import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth/auth";
import { listDomainSummaries, readMailbox } from "../../lib/catalog/catalog-store";
import { buildConsoleDashboardStats } from "../../lib/ops/build-console-stats";
import { createAppDb } from "../../../db/app";

const consoleDashboard = new Hono<{ Bindings: Env }>();

/** Single page-load payload: KPI stats + lightweight domain list (no CF enrich). */
consoleDashboard.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  const range = c.req.query("range");
  const domain = c.req.query("domain")?.trim().toLowerCase() || null;

  const [stats, mailbox] = await Promise.all([
    buildConsoleDashboardStats(c.env, range, domain),
    readMailbox(createAppDb(c.env.RELAYBASE_DB)),
  ]);

  return c.json({
    stats,
    domains: listDomainSummaries(mailbox),
    workerConnected: true,
  });
});

export { consoleDashboard };
