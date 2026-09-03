import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { createAppDb } from "../../../db/app";
import {
  addManualContact,
  createAudienceGroup,
  deleteAudienceGroup,
  fetchDataSourceContacts,
  getGroupDetail,
  getGroupProgress,
  listGroupSummaries,
  mergeDataSource,
  readAudienceCatalog,
  removeContact,
  syncAudienceGroup,
  updateAudienceGroup,
} from "../../lib/catalog-audience";
import type { AudienceDataSourcePatch } from "../../lib/catalog-types";

const consoleAudienceGroups = new Hono<{ Bindings: Env }>();

consoleAudienceGroups.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const catalog = await readAudienceCatalog(createAppDb(c.env.RELAYBASE_DB));
  return c.json({ groups: listGroupSummaries(catalog) });
});

consoleAudienceGroups.post("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  let body: {
    name?: string;
    domain?: string;
    dataSource?: AudienceDataSourcePatch;
    cronEnabled?: boolean;
    cronIntervalMinutes?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const group = await createAudienceGroup(createAppDb(c.env.RELAYBASE_DB), {
      name: body.name ?? "",
      domain: body.domain ?? "",
      dataSource: body.dataSource,
      cronEnabled: body.cronEnabled,
      cronIntervalMinutes: body.cronIntervalMinutes,
    });
    return c.json({ group }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return c.json({ error: message }, 400);
  }
});

consoleAudienceGroups.post("/test", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  let body: AudienceDataSourcePatch & { groupId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    let previous;
    if (body.groupId) {
      const catalog = await readAudienceCatalog(createAppDb(c.env.RELAYBASE_DB));
      previous = catalog.groups.find((g) => g.id === body.groupId)?.dataSource;
    }
    const dataSource = mergeDataSource(previous, body);
    const result = await fetchDataSourceContacts(dataSource);
    return c.json({
      ok: true,
      count: result.contacts.length,
      skippedCount: result.skippedCount,
      sample: result.contacts.slice(0, 5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Test failed";
    return c.json({ error: message }, 400);
  }
});

consoleAudienceGroups.get("/:groupId", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const catalog = await readAudienceCatalog(createAppDb(c.env.RELAYBASE_DB));
  const detail = getGroupDetail(catalog, c.req.param("groupId"));
  if (!detail) return c.json({ error: "Audience group not found" }, 404);
  return c.json(detail);
});

consoleAudienceGroups.patch("/:groupId", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  let body: Parameters<typeof updateAudienceGroup>[2];
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const group = await updateAudienceGroup(
      createAppDb(c.env.RELAYBASE_DB),
      c.req.param("groupId"),
      body,
    );
    return c.json({ group });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return c.json({ error: message }, 400);
  }
});

consoleAudienceGroups.delete("/:groupId", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  try {
    await deleteAudienceGroup(createAppDb(c.env.RELAYBASE_DB), c.req.param("groupId"));
    return c.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return c.json({ error: message }, 400);
  }
});

consoleAudienceGroups.get("/:groupId/contacts", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const catalog = await readAudienceCatalog(createAppDb(c.env.RELAYBASE_DB));
  const detail = getGroupDetail(catalog, c.req.param("groupId"));
  if (!detail) return c.json({ error: "Audience group not found" }, 404);
  return c.json({ contacts: detail.contacts });
});

consoleAudienceGroups.post("/:groupId/contacts", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  let body: { email?: string; name?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const contact = await addManualContact(
      createAppDb(c.env.RELAYBASE_DB),
      c.req.param("groupId"),
      { email: body.email ?? "", name: body.name },
    );
    return c.json({ contact }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return c.json({ error: message }, 400);
  }
});

consoleAudienceGroups.delete("/:groupId/contacts", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const contactId = c.req.query("id")?.trim();
  if (!contactId) return c.json({ error: "id is required" }, 400);
  try {
    await removeContact(
      createAppDb(c.env.RELAYBASE_DB),
      c.req.param("groupId"),
      contactId,
    );
    return c.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return c.json({ error: message }, 400);
  }
});

consoleAudienceGroups.post("/:groupId/sync", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  try {
    const result = await syncAudienceGroup(
      createAppDb(c.env.RELAYBASE_DB),
      c.req.param("groupId"),
      { trigger: "manual" },
    );
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return c.json({ error: message }, 400);
  }
});

consoleAudienceGroups.get("/:groupId/progress", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const catalog = await readAudienceCatalog(createAppDb(c.env.RELAYBASE_DB));
  const progress = getGroupProgress(catalog, c.req.param("groupId"));
  if (!progress) return c.json({ error: "Audience group not found" }, 404);
  return c.json(progress);
});

export { consoleAudienceGroups };
