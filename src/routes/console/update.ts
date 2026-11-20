import { Hono, type Context } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth/auth";
import { cloudflareToken, readUpdateAccess } from "../../lib/update/access";
import { ensureUpdateSchedule } from "../../lib/update/cron";
import {
  advanceJob,
  cancelJob,
  createJob,
  jobView,
  lastUpdateFrom,
  latestJob,
  retryJob,
  runningJob,
  type UpdateJob,
} from "../../lib/update/jobs";
import { blockedReason, rolloutHeld } from "../../lib/update/policy";
import { latestRelease, releaseManifest, type ReleaseManifest } from "../../lib/update/release-client";
import { autoUpdateEnabled, setAutoUpdate } from "../../lib/update/schedule";
import { ensureUpdateTables } from "../../lib/update/schema";
import { BUILD_VERSION, compareVersions, isVersion } from "../../lib/update/version";

/**
 * Self-update API (Dotnote's `/api/update/*`), owner only: whoever can call
 * these can replace the Worker. The app's update banner and Settings › Updates
 * read `check` and drive the job with `step`.
 */
const consoleUpdate = new Hono<{ Bindings: Env }>();

consoleUpdate.use("*", async (c, next) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  if (!c.env.RELAYBASE_DB) return c.json({ error: "Product database is not configured" }, 503);
  await ensureUpdateTables(c.env);
  await next();
});

async function rollbackTarget(env: Env): Promise<string | null> {
  const from = await lastUpdateFrom(env, BUILD_VERSION);
  return from && from !== BUILD_VERSION ? from : null;
}

function statusBody(job: UpdateJob | null, retryAfterMs?: number) {
  return { currentVersion: BUILD_VERSION, job: job ? jobView(job, retryAfterMs) : null };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

async function readVersion(c: Context<{ Bindings: Env }>): Promise<string | null> {
  try {
    const body = (await c.req.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version.length <= 64 ? body.version : null;
  } catch {
    return null;
  }
}

consoleUpdate.get("/check", async (c) => {
  const access = await readUpdateAccess(c.env);
  const blocked = blockedReason(c.env, access);
  const job = await latestJob(c.env);
  let release: ReleaseManifest | null = null;
  let error: string | null = null;
  if (blocked !== "no_release_origin") {
    try {
      release = await latestRelease(c.env, { force: c.req.query("force") === "1" });
    } catch (err) {
      error = errorMessage(err, "The release host could not be reached.");
    }
  }
  const newer = !!release && compareVersions(release.version, BUILD_VERSION) > 0;
  const held = newer && rolloutHeld(c.env, access, release!, new URL(c.req.url).host);
  const offered = newer && !held;
  return c.json({
    checkedAt: new Date().toISOString(),
    currentVersion: BUILD_VERSION,
    latestVersion: release?.version ?? null,
    updateAvailable: offered,
    releasedAt: offered ? release!.releasedAt : null,
    notes: offered ? release!.notes : null,
    sizeBytes: offered ? release!.sizeBytes : null,
    canUpdate: blocked === null,
    blockedReason: blocked,
    rolloutHeld: held,
    rollbackVersion: blocked === null ? await rollbackTarget(c.env) : null,
    error,
    job: job ? jobView(job) : null,
    credential: access.credential,
    autoUpdate: await autoUpdateEnabled(c.env),
  });
});

consoleUpdate.get("/status", async (c) => c.json(statusBody(await latestJob(c.env))));

consoleUpdate.post("/start", async (c) => {
  const access = await readUpdateAccess(c.env);
  const blocked = blockedReason(c.env, access);
  if (blocked) return c.json({ error: blocked }, 403);
  const version = await readVersion(c);
  if (!version || !isVersion(version) || compareVersions(version, BUILD_VERSION) <= 0) {
    return c.json({ error: "not_newer", message: `${version ?? "?"} is not newer than ${BUILD_VERSION}.` }, 409);
  }
  let release: ReleaseManifest;
  try {
    release = await latestRelease(c.env, { force: true });
  } catch (err) {
    return c.json({ error: "release_unavailable", message: errorMessage(err, "No release is available.") }, 502);
  }
  if (release.version !== version) return c.json({ error: "release_changed", latestVersion: release.version }, 409);
  if (rolloutHeld(c.env, access, release, new URL(c.req.url).host)) return c.json({ error: "rollout_held" }, 409);
  const job = await createJob(c.env, "update", BUILD_VERSION, version);
  if (!job) return c.json({ error: "update_in_progress" }, 409);
  return c.json(statusBody(job, 0), 202);
});

consoleUpdate.post("/rollback", async (c) => {
  const blocked = blockedReason(c.env, await readUpdateAccess(c.env));
  if (blocked) return c.json({ error: blocked }, 403);
  const version = await readVersion(c);
  if (!version || (await rollbackTarget(c.env)) !== version) return c.json({ error: "no_rollback" }, 409);
  try {
    await releaseManifest(c.env, version);
  } catch (err) {
    return c.json({ error: "release_gone", message: errorMessage(err, `${version} is gone.`) }, 404);
  }
  const job = await createJob(c.env, "rollback", BUILD_VERSION, version);
  if (!job) return c.json({ error: "update_in_progress" }, 409);
  return c.json(statusBody(job, 0), 202);
});

/** Run the next piece of the running job. Any open tab may call it; one request works at a time. */
consoleUpdate.post("/step", async (c) => {
  const running = await runningJob(c.env);
  if (!running) return c.json(statusBody(await latestJob(c.env)));
  const { job, retryAfterMs } = await advanceJob(c.env, running.id);
  return c.json(statusBody(job, retryAfterMs));
});

consoleUpdate.post("/retry", async (c) => {
  const blocked = blockedReason(c.env, await readUpdateAccess(c.env));
  if (blocked) return c.json({ error: blocked }, 403);
  const latest = await latestJob(c.env);
  if (!latest || latest.status !== "failed") return c.json({ error: "nothing_to_retry" }, 409);
  const job = await retryJob(c.env, latest);
  if (!job) return c.json({ error: "update_in_progress" }, 409);
  return c.json(statusBody(job, 0));
});

consoleUpdate.post("/cancel", async (c) => {
  const latest = await latestJob(c.env);
  if (!latest || latest.status !== "failed") return c.json({ error: "nothing_to_cancel" }, 409);
  return c.json(statusBody(await cancelJob(c.env, latest)));
});

/** Automatic updates. Turning them on needs a working grant and puts the update Cron Trigger on the Worker. */
consoleUpdate.post("/auto", async (c) => {
  let enabled: boolean;
  try {
    enabled = ((await c.req.json()) as { enabled?: unknown }).enabled === true;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (enabled) {
    const blocked = blockedReason(c.env, await readUpdateAccess(c.env));
    if (blocked) return c.json({ error: blocked }, 403);
    try {
      const { token, accountId, scriptName } = await cloudflareToken(c.env);
      await ensureUpdateSchedule(token, accountId, scriptName);
    } catch (err) {
      return c.json({ error: "schedule_failed", message: errorMessage(err, "Cloudflare refused the Cron Trigger.") }, 502);
    }
  }
  await setAutoUpdate(c.env, enabled);
  return c.json({ autoUpdate: enabled });
});

export { consoleUpdate };
