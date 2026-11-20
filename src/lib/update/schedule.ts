import type { Env } from "../../env";
import { readUpdateAccess } from "./access";
import { advanceJob, createJob, getJob, runningJob, triedBefore, type UpdateJob } from "./jobs";
import { automaticSkip, blockedReason, rolloutHeld } from "./policy";
import { latestRelease } from "./release-client";
import { ensureUpdateTables, getMeta, setMeta } from "./schema";
import { BUILD_VERSION, compareVersions } from "./version";

/**
 * Updates without an open tab. The update Cron Trigger (cron.ts) runs this
 * every 30 minutes; each run drives a job a tab left running and, with
 * automatic updates on, starts one for a newer release.
 */

/** app_meta key. On unless the owner turns it off (Settings › Updates). */
const AUTO_UPDATE_KEY = "auto_update";
const RUN_BUDGET_MS = 5 * 60_000;

export async function autoUpdateEnabled(env: Env): Promise<boolean> {
  return (await getMeta(env, AUTO_UPDATE_KEY)) !== "0";
}

export async function setAutoUpdate(env: Env, enabled: boolean): Promise<void> {
  await setMeta(env, AUTO_UPDATE_KEY, enabled ? "1" : "0");
}

async function startAutomaticUpdate(env: Env): Promise<UpdateJob | null> {
  const enabled = await autoUpdateEnabled(env);
  if (!enabled) return null;
  const access = await readUpdateAccess(env);
  const blocked = blockedReason(env, access) !== null;
  const release = blocked ? null : await latestRelease(env);
  const newer = !!release && compareVersions(release.version, BUILD_VERSION) > 0;
  const skip = automaticSkip({
    enabled,
    blocked,
    newer,
    release: release ?? { autoUpdate: false },
    held: !!release && newer && rolloutHeld(env, access, release, ""),
    triedBefore: !!release && newer && (await triedBefore(env, release.version)),
  });
  if (skip || !release) return null;
  const job = await createJob(env, "update", BUILD_VERSION, release.version);
  if (job) console.log(JSON.stringify({ event: "auto_update_started", from: BUILD_VERSION, to: release.version }));
  return job;
}

async function driveJob(env: Env, jobId: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    const job = await getJob(env, jobId);
    if (!job || job.status !== "running") return;
    // This code cannot pass `verify` for another version. The next run is the new code.
    if (job.step === "verify" && job.toVersion !== BUILD_VERSION) return;
    const { job: after, retryAfterMs } = await advanceJob(env, jobId);
    if (after.status !== "running") return;
    const wait = Math.min(retryAfterMs ?? 0, deadline - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** The update Cron Trigger's handler. */
export async function runScheduledUpdate(env: Env): Promise<void> {
  if (!env.RELAYBASE_DB) return;
  await ensureUpdateTables(env);
  const job = (await runningJob(env)) ?? (await startAutomaticUpdate(env));
  if (job) await driveJob(env, job.id, Date.now() + RUN_BUDGET_MS);
}
