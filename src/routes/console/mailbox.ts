import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { createAppDb } from "../../../db/app";
import {
  normalizeDomain,
  normalizeMailboxAddress,
  readMailbox,
  writeMailbox,
  type MailboxAddress,
} from "../../lib/catalog-store";

const consoleMailbox = new Hono<{ Bindings: Env }>();

/** Full mailbox blob (domains + addresses). */
consoleMailbox.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const data = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
  return c.json(data);
});

consoleMailbox.put("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  let body: { domains?: string[]; addresses?: MailboxAddress[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const domains = Array.isArray(body.domains)
    ? [
        ...new Set(
          body.domains
            .filter((d): d is string => typeof d === "string")
            .map(normalizeDomain)
            .filter(Boolean),
        ),
      ].sort()
    : [];
  const addresses = Array.isArray(body.addresses)
    ? body.addresses
        .filter(
          (a): a is MailboxAddress =>
            !!a &&
            typeof a === "object" &&
            typeof a.email === "string" &&
            typeof a.domain === "string",
        )
        .map((a) =>
          normalizeMailboxAddress({
            email: a.email,
            domain: a.domain,
            displayName:
              typeof a.displayName === "string" ? a.displayName : undefined,
            inboundEnabled:
              a.inboundEnabled === false
                ? false
                : a.inboundEnabled === true
                  ? true
                  : undefined,
          }),
        )
    : [];
  const data = { domains, addresses };
  await writeMailbox(createAppDb(c.env.RELAYBASE_DB), data);
  return c.json(data);
});

/** Config subset for EmailMailboxStore. */
consoleMailbox.get("/config", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const data = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
  const domains = data.domains;
  const emailDomain = domains[0] ?? "";
  return c.json({
    emailDomain,
    domain: emailDomain,
    domains,
    activeDomain: emailDomain || null,
    registeredAddresses: data.addresses.map((a) => a.email),
    configured: domains.length > 0,
    relaybaseConfigured: true,
    relaybaseAuthConfigured: true,
    cloudflareConfigured: true,
    credentialSource: "integration",
    usesIntegrationCredentials: true,
    audienceContacts: [],
    broadcasts: [],
    relaybaseWorkerUrl: "",
  });
});

export { consoleMailbox };
