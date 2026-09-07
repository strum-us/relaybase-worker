import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { createCloudflareClient } from "../../lib/cloudflare-config";
import { createAppDb } from "../../../db/app";
import {
  ensureInboundRouting,
  MxConflictError,
  removeInboundWorkerRouting,
} from "../../lib/inbound-routing";
import {
  CF_TOKEN_PERMISSION_ERROR_CODE,
  isCloudflareTokenPermissionError,
} from "../../lib/cloudflare-api-hints";
import { probeCfApiTokenPermissions } from "../../lib/cloudflare-probe";
import {
  normalizeDomain,
  readMailbox,
  removeAddress,
  updateAddress,
  upsertAddresses,
} from "../../lib/catalog-store";
import {
  clearAccountMobileConfig,
  getAccountMobileConfig,
  rotateAccountMobileConfig,
  toAccountMobileConfigPublicView,
} from "../../lib/mobile-config";

const consoleAddresses = new Hono<{ Bindings: Env }>();

consoleAddresses.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const data = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
  if (c.req.query("all") === "1") {
    return c.json({ addresses: data.addresses });
  }
  const domain = normalizeDomain(c.req.query("domain") ?? "");
  if (!domain) {
    return c.json({ error: "domain query required" }, 400);
  }
  if (!data.domains.includes(domain)) {
    return c.json({ error: "Domain not found" }, 404);
  }
  return c.json({
    addresses: data.addresses.filter((a) => a.domain === domain),
  });
});

consoleAddresses.post("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  let body: {
    localPart?: string;
    localParts?: string[];
    displayName?: string;
    displayNames?: Record<string, string>;
    inboundEnabled?: boolean;
    inboundEnabledByLocalPart?: Record<string, boolean>;
    domain?: string;
    forceMxResolve?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const domain = normalizeDomain(
    body.domain ?? c.req.query("domain") ?? "",
  );
  if (!domain) {
    return c.json(
      { error: "Select a domain before adding senders" },
      400,
    );
  }

  const localParts = (
    Array.isArray(body.localParts) && body.localParts.length
      ? body.localParts
      : body.localPart
        ? [body.localPart]
        : []
  )
    .map((part) => part.trim())
    .filter(Boolean);

  if (!localParts.length) {
    return c.json(
      { error: "localPart or localParts is required" },
      400,
    );
  }

  const emails = [
    ...new Set(localParts.map((part) => `${part}@${domain}`.toLowerCase())),
  ];

  const inboundByLocal =
    body.inboundEnabledByLocalPart &&
    typeof body.inboundEnabledByLocalPart === "object"
      ? body.inboundEnabledByLocalPart
      : {};

  const singleDisplayName =
    typeof body.displayName === "string" ? body.displayName.trim() : "";
  const displayNames =
    body.displayNames && typeof body.displayNames === "object"
      ? body.displayNames
      : {};

  const entries = emails.map((email) => {
    const local = email.split("@")[0] ?? "";
    const fromMap =
      typeof displayNames[local] === "string"
        ? displayNames[local]!.trim()
        : "";
    const inboundFromMap =
      typeof inboundByLocal[local] === "boolean"
        ? inboundByLocal[local]
        : typeof inboundByLocal[local.toLowerCase()] === "boolean"
          ? inboundByLocal[local.toLowerCase()]
          : undefined;
    const inboundEnabled =
      typeof inboundFromMap === "boolean"
        ? inboundFromMap
        : typeof body.inboundEnabled === "boolean"
          ? body.inboundEnabled
          : true;
    return {
      email,
      displayName: fromMap || singleDisplayName || undefined,
      inboundEnabled,
    };
  });

  try {
    const cf = await createCloudflareClient(c.env);
    await ensureInboundRouting(
      cf,
      domain,
      entries.map((entry) => ({
        address: entry.email,
        inboundEnabled: entry.inboundEnabled,
      })),
      c.env.WORKER_SCRIPT_NAME,
      { forceMxResolve: body.forceMxResolve === true },
    );
  } catch (error) {
    if (error instanceof MxConflictError) {
      return c.json(
        {
          error:
            "Non-Cloudflare MX records exist for this domain. Remove them to enable Email Routing.",
          mxConflict: true,
          domain: error.domain,
          mxConflicts: error.mxConflicts,
        },
        409,
      );
    }
    const message =
      error instanceof Error
        ? error.message
        : "Failed to configure inbound routing";
    const isPermError = isCloudflareTokenPermissionError(message);

    // Run the permission probe inline so the desktop can show exactly
    // which row failed (Zone Read, Email Routing Edit, DNS Edit) instead
    // of a generic "Email Routing permissions" toast.
    let cfApiTokenPermissions = null;
    if (isPermError) {
      try {
        const mailbox = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
        const probe = await probeCfApiTokenPermissions(
          c.env.CF_API_TOKEN ?? "",
          { knownDomains: mailbox.domains },
        );
        cfApiTokenPermissions = probe.permissions;
      } catch {
        // ignore probe failure — still return the error code
      }
    }

    return c.json(
      {
        error: `Could not configure inbox for ${emails.join(", ")}: ${message}`,
        code: isPermError ? CF_TOKEN_PERMISSION_ERROR_CODE : undefined,
        domain,
        cfApiTokenPermissions,
      },
      502,
    );
  }

  const { data, added } = await upsertAddresses(createAppDb(c.env.RELAYBASE_DB), domain, entries);
  if (added.length === 1) {
    return c.json({ address: added[0], addresses: added });
  }
  return c.json({
    addresses: added,
    all: data.addresses.filter((a) => a.domain === domain),
  });
});

consoleAddresses.patch("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  let body: {
    email?: string;
    displayName?: string | null;
    signature?: string | null;
    inboundEnabled?: boolean;
    mobileEnabled?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const email = body.email?.trim().toLowerCase();
  if (!email) {
    return c.json({ error: "email is required" }, 400);
  }

  const data = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
  const index = data.addresses.findIndex((a) => a.email === email);
  if (index < 0) {
    return c.json({ error: "Address not found" }, 404);
  }

  const current = data.addresses[index]!;
  const displayName =
    typeof body.displayName === "string"
      ? body.displayName.trim()
      : body.displayName === null
        ? ""
        : undefined;
  const signature =
    typeof body.signature === "string"
      ? body.signature
      : body.signature === null
        ? ""
        : undefined;
  const inboundEnabled =
    typeof body.inboundEnabled === "boolean"
      ? body.inboundEnabled
      : current.inboundEnabled !== false;
  const mobileEnabled =
    typeof body.mobileEnabled === "boolean"
      ? body.mobileEnabled
      : current.mobileEnabled !== false;

  if (
    displayName === undefined &&
    signature === undefined &&
    typeof body.inboundEnabled !== "boolean" &&
    typeof body.mobileEnabled !== "boolean"
  ) {
    return c.json({ address: current });
  }

  if (typeof body.inboundEnabled === "boolean") {
    try {
      const cf = await createCloudflareClient(c.env);
      await ensureInboundRouting(
        cf,
        current.domain,
        [{ address: email, inboundEnabled }],
        c.env.WORKER_SCRIPT_NAME,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to update inbound routing";
      const isPermError = isCloudflareTokenPermissionError(message);
      return c.json(
        {
          error: message,
          code: isPermError ? CF_TOKEN_PERMISSION_ERROR_CODE : undefined,
          domain: current.domain,
        },
        502,
      );
    }
  }

  const updated = await updateAddress(createAppDb(c.env.RELAYBASE_DB), email, {
    displayName,
    signature,
    inboundEnabled,
    mobileEnabled,
  });
  if (!updated) {
    return c.json({ error: "Address not found" }, 404);
  }

  return c.json({ address: updated });
});

consoleAddresses.delete("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const email = c.req.query("email")?.trim().toLowerCase();
  if (!email) {
    return c.json({ error: "email is required" }, 400);
  }

  const { data, removed } = await removeAddress(createAppDb(c.env.RELAYBASE_DB), email);
  if (removed) {
    try {
      const cf = await createCloudflareClient(c.env);
      await removeInboundWorkerRouting(cf, removed.domain, [removed.email]);
    } catch (error) {
      console.error("Failed to remove inbound routing", error);
    }
  }

  const domain = c.req.query("domain")?.trim().toLowerCase();
  return c.json({
    addresses: domain
      ? data.addresses.filter((a) => a.domain === domain)
      : data.addresses,
  });
});

/**
 * Per-account mobile password. The desktop Other device tab generates a
 * password per address (shown once) and stores a salted SHA-256 hash here.
 * The Flutter app logs in with the account email + this password.
 */
consoleAddresses.get("/mobile-password", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const email = c.req.query("email")?.trim().toLowerCase();
  if (!email) {
    return c.json({ error: "email is required" }, 400);
  }
  const config = await getAccountMobileConfig(createAppDb(c.env.RELAYBASE_DB), email);
  return c.json(toAccountMobileConfigPublicView(config));
});

/** Generate or regenerate the per-account mobile password. Returns the plain password once. */
consoleAddresses.post("/mobile-password", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  let body: { email?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const email = body.email?.trim().toLowerCase();
  if (!email) {
    return c.json({ error: "email is required" }, 400);
  }
  const { password, config } = await rotateAccountMobileConfig(
    createAppDb(c.env.RELAYBASE_DB),
    email,
  );
  return c.json({
    password,
    hasPassword: true,
    updatedAt: config.updatedAt,
  });
});

/** Clear the per-account mobile password (disables mobile login for this account). */
consoleAddresses.delete("/mobile-password", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const email = c.req.query("email")?.trim().toLowerCase();
  if (!email) {
    return c.json({ error: "email is required" }, 400);
  }
  await clearAccountMobileConfig(createAppDb(c.env.RELAYBASE_DB), email);
  return c.json({ hasPassword: false, updatedAt: null });
});

export { consoleAddresses };
