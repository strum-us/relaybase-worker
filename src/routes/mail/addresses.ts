import { Hono } from "hono";
import type { Env } from "../../env";
import { requireMailSession } from "../../lib/auth";
import { createAppDb } from "../../../db/app";
import { readMailbox } from "../../lib/catalog-store";

const mailAddresses = new Hono<{ Bindings: Env }>();

/** Read-only address catalog for the mail sidebar (mail-scoped session). */
mailAddresses.get("/", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;
  const data = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
  return c.json({ addresses: data.addresses });
});

export { mailAddresses };
