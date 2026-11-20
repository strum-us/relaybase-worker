import type { Env } from "../../env";
import { applyMigrationList, appliedMigrationNames } from "../d1/d1-migrations";
import { cloudflareToken } from "./access";
import {
  CfApiError,
  listSecretNames,
  putScript,
  putSecret,
  scriptSettings,
  type ScriptBinding,
  type ScriptSettings,
} from "./cf-deploy";
import { ensureUpdateSchedule } from "./cron";
import { releaseManifest, workerSource, type ReleaseManifest } from "./release-client";
import { setMeta, updateDb } from "./schema";
import { BUILD_VERSION } from "./version";

/**
 * Self-update job (Dotnote's updater, minus static assets: this Worker has
 * none). The app's update banner drives it one step per request, or the cron
 * run does when no tab is open (schedule.ts), so no request runs into the
 * subrequest or wall-clock limits and every step is saved before the next.
 * `deploy` replaces this very Worker; `verify` only passes once a request is
 * answered by the new code.
 */
export type UpdateStepId = "prepare" | "migrate" | "deploy" | "verify";

export const STEPS: { id: UpdateStepId; label: string }[] = [
  { id: "prepare", label: "Check the release" },
  { id: "migrate", label: "Apply database migrations" },
  { id: "deploy", label: "Replace the Worker" },
  { id: "verify", label: "Wait for the new version" },
];

export type UpdateErrorCode = "error" | "permission" | "unverified";
export type UpdateJobStatus = "running" | "done" | "failed" | "cancelled";
export type UpdateJobKind = "update" | "rollback";

export type UpdateJobView = {
  id: string;
  kind: UpdateJobKind;
  fromVersion: string;
  toVersion: string;
  status: UpdateJobStatus;
  step: { id: UpdateStepId; label: string; index: number; total: number };
  message: string | null;
  errorCode: UpdateErrorCode | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  retryAfterMs?: number;
};

const LEASE_MS = 120_000;
const BUSY_RETRY_MS = 1500;
const VERIFY_RETRY_MS = 2000;
const VERIFY_TIMEOUT_MS = 90_000;
const MAX_INTERRUPTED = 3;

/**
 * Install-time secrets. `keep_bindings` carries them across the upload; if one
 * is missing afterwards it is put back from this isolate's env. CF_GRANT_KEY is
 * never regenerated: a new key could not decrypt the stored grant.
 */
const KEPT_SECRETS = ["CF_GRANT_KEY", "RELAYBASE_HANDOFF", "AUTH_PEPPER"] as const;
const SECRET_TYPES = new Set(["secret_text", "secret_key"]);
/** Bindings that point at extra module parts. The upload only sends one module, so these cannot be carried. */
const PART_BINDING_TYPES = new Set(["wasm_module", "text_blob", "data_blob"]);
/** Plain vars the updater rewrites with the new release. */
const VERSION_VARS = new Set(["WORKER_VERSION"]);

type JobState = {
  pending?: string[];
  deployedAt?: string;
  inStep?: UpdateStepId;
  interrupted?: number;
};

export type UpdateJob = {
  id: string;
  kind: UpdateJobKind;
  fromVersion: string;
  toVersion: string;
  step: UpdateStepId;
  status: UpdateJobStatus;
  message: string | null;
  errorCode: UpdateErrorCode | null;
  state: JobState;
  leaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

type StepResult = { done: boolean; waitMs?: number };

class StepWait extends Error {
  constructor(
    readonly ms: number,
    message: string,
  ) {
    super(message);
  }
}

class StepError extends Error {
  constructor(
    message: string,
    readonly code: UpdateErrorCode = "error",
  ) {
    super(message);
  }
}

const SELECT_JOB = `SELECT id, kind, from_version as fromVersion, to_version as toVersion, step, status, message,
  error_code as errorCode, state, lease_until as leaseUntil, created_at as createdAt, updated_at as updatedAt,
  finished_at as finishedAt FROM update_jobs`;

function iso(ms = Date.now()): string {
  return new Date(ms).toISOString();
}

function parseJob(row: (Omit<UpdateJob, "state"> & { state: string }) | null): UpdateJob | null {
  if (!row) return null;
  let state: JobState = {};
  try {
    state = JSON.parse(row.state) as JobState;
  } catch {
    state = {};
  }
  return { ...row, state };
}

export async function getJob(env: Env, id: string): Promise<UpdateJob | null> {
  return parseJob(await updateDb(env).prepare(`${SELECT_JOB} WHERE id = ?`).bind(id).first());
}

export async function latestJob(env: Env): Promise<UpdateJob | null> {
  return parseJob(await updateDb(env).prepare(`${SELECT_JOB} ORDER BY created_at DESC LIMIT 1`).first());
}

export async function runningJob(env: Env): Promise<UpdateJob | null> {
  return parseJob(
    await updateDb(env).prepare(`${SELECT_JOB} WHERE status = 'running' ORDER BY created_at DESC LIMIT 1`).first(),
  );
}

/** The version the running one was updated from, if this Worker updated itself to get here. */
export async function lastUpdateFrom(env: Env, version: string): Promise<string | null> {
  const row = await updateDb(env)
    .prepare(
      `SELECT from_version as fromVersion FROM update_jobs
       WHERE kind = 'update' AND status = 'done' AND to_version = ?
       ORDER BY finished_at DESC LIMIT 1`,
    )
    .bind(version)
    .first<{ fromVersion: string }>();
  return row?.fromVersion ?? null;
}

/** An update to this version failed or was set aside, or this Worker went back from it. */
export async function triedBefore(env: Env, version: string): Promise<boolean> {
  const row = await updateDb(env)
    .prepare(
      `SELECT 1 as hit FROM update_jobs
       WHERE (kind = 'update' AND to_version = ?1 AND status IN ('failed', 'cancelled'))
          OR (kind = 'rollback' AND from_version = ?1 AND status = 'done')
       LIMIT 1`,
    )
    .bind(version)
    .first<{ hit: number }>();
  return !!row;
}

/** A new job, unless one is already running. The check and the insert are one statement. */
export async function createJob(
  env: Env,
  kind: UpdateJobKind,
  fromVersion: string,
  toVersion: string,
): Promise<UpdateJob | null> {
  const id = crypto.randomUUID();
  const now = iso();
  const inserted = await updateDb(env)
    .prepare(
      `INSERT INTO update_jobs (id, kind, from_version, to_version, step, status, state, created_at, updated_at)
       SELECT ?, ?, ?, ?, 'prepare', 'running', '{}', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM update_jobs WHERE status = 'running')`,
    )
    .bind(id, kind, fromVersion, toVersion, now, now)
    .run();
  if (!inserted.meta.changes) return null;
  return getJob(env, id);
}

async function saveJob(env: Env, job: UpdateJob): Promise<void> {
  job.updatedAt = iso();
  await updateDb(env)
    .prepare(
      `UPDATE update_jobs SET step = ?, status = ?, message = ?, error_code = ?, state = ?, lease_until = ?,
         updated_at = ?, finished_at = ?
       WHERE id = ?`,
    )
    .bind(
      job.step,
      job.status,
      job.message,
      job.errorCode,
      JSON.stringify(job.state),
      job.leaseUntil,
      job.updatedAt,
      job.finishedAt,
      job.id,
    )
    .run();
}

export function jobView(job: UpdateJob, retryAfterMs?: number): UpdateJobView {
  const done = job.status === "done";
  const index = done ? STEPS.length : Math.max(0, STEPS.findIndex((step) => step.id === job.step));
  const step = STEPS[Math.min(index, STEPS.length - 1)]!;
  const view: UpdateJobView = {
    id: job.id,
    kind: job.kind,
    fromVersion: job.fromVersion,
    toVersion: job.toVersion,
    status: job.status,
    step: { id: step.id, label: done ? "Done" : step.label, index, total: STEPS.length },
    message: job.message,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
  };
  if (job.status === "running" && retryAfterMs !== undefined) view.retryAfterMs = retryAfterMs;
  return view;
}

function classify(err: unknown): { message: string; code: UpdateErrorCode } {
  if (err instanceof StepError) return { message: err.message, code: err.code };
  if (err instanceof CfApiError && (err.status === 401 || err.status === 403)) {
    return { message: `Cloudflare refused the request: ${err.message}`, code: "permission" };
  }
  return { message: err instanceof Error ? err.message : "The step failed.", code: "error" };
}

async function cloudflare(env: Env): Promise<{ token: string; accountId: string; scriptName: string }> {
  try {
    return await cloudflareToken(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/already being renewed/i.test(message)) throw new StepWait(3000, "Waiting for Cloudflare access");
    if (/decrypt|ciphertext/i.test(message)) {
      throw new StepError("The stored Cloudflare permission could not be read. Reconnect Cloudflare.", "permission");
    }
    throw new StepError(message || "The stored Cloudflare permission could not be renewed.", "permission");
  }
}

async function pendingNames(env: Env, release: ReleaseManifest): Promise<string[]> {
  const ledgers = new Map<string, Set<string>>();
  const pending: string[] = [];
  for (const file of release.migrations) {
    if (!ledgers.has(file.target)) ledgers.set(file.target, await appliedMigrationNames(env, file.target));
    if (!ledgers.get(file.target)!.has(file.name)) pending.push(`${file.target}/${file.name}`);
  }
  return pending;
}

async function prepare(env: Env, job: UpdateJob): Promise<StepResult> {
  const release = await releaseManifest(env, job.toVersion);
  job.state.pending = job.kind === "rollback" ? [] : await pendingNames(env, release);
  // Fail on a revoked permission or a renamed Worker before the database is touched.
  const { token, accountId, scriptName } = await cloudflare(env);
  const settings = await scriptSettings(token, accountId, scriptName);
  const unsupported = (settings.bindings ?? []).filter((binding) => PART_BINDING_TYPES.has(binding.type));
  if (unsupported.length) {
    throw new StepError(
      `This Worker has bindings the updater cannot carry over: ${unsupported.map((b) => b.name).join(", ")}.`,
    );
  }
  const count = job.state.pending.length;
  job.message = count === 0 ? null : count === 1 ? "1 database migration to apply" : `${count} database migrations to apply`;
  return { done: true };
}

/**
 * Migrations run before the new code exists, so the old Worker serves on top
 * of them for a while. They must only add (tables, columns, indexes) and be
 * safe to run twice. The ledger is the same `d1_migrations` init-db uses.
 */
async function migrate(env: Env, job: UpdateJob): Promise<StepResult> {
  if (!job.state.pending?.length) {
    job.message = null;
    return { done: true };
  }
  const release = await releaseManifest(env, job.toVersion);
  const result = await applyMigrationList(env, release.migrations);
  if (result.errors.length) throw new StepError(`Database migration failed: ${result.errors.join("; ")}`);
  job.message = result.applied.length ? `Applied ${result.applied.length} migration(s)` : null;
  return { done: true };
}

/**
 * Keep every binding the deployed script has (D1, R2, send_email, vars), refresh
 * the version vars, and keep secrets by type instead of resending them.
 */
function scriptMetadata(settings: ScriptSettings, release: ReleaseManifest): Record<string, unknown> {
  const bindings: ScriptBinding[] = (settings.bindings ?? []).filter(
    (binding) => !SECRET_TYPES.has(binding.type) && !VERSION_VARS.has(binding.name),
  );
  bindings.push({ type: "plain_text", name: "WORKER_VERSION", text: release.version });
  const metadata: Record<string, unknown> = {
    main_module: release.mainModule,
    compatibility_date: release.compatibilityDate,
    compatibility_flags: release.compatibilityFlags,
    bindings,
    keep_bindings: [...SECRET_TYPES],
  };
  if (settings.limits) metadata.limits = settings.limits;
  if (settings.placement) metadata.placement = settings.placement;
  if (typeof settings.logpush === "boolean") metadata.logpush = settings.logpush;
  if (settings.observability) metadata.observability = settings.observability;
  if (settings.tail_consumers?.length) metadata.tail_consumers = settings.tail_consumers;
  return metadata;
}

async function keepSecrets(env: Env, token: string, accountId: string, scriptName: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const present = new Set(await listSecretNames(token, accountId, scriptName));
      for (const name of KEPT_SECRETS) {
        const value = env[name];
        if (value && !present.has(name)) await putSecret(token, accountId, scriptName, name, value);
      }
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

async function deploy(env: Env, job: UpdateJob): Promise<StepResult> {
  // A retry after an upload that went through but was not recorded.
  if (BUILD_VERSION === job.toVersion) {
    job.state.deployedAt ??= iso();
    return { done: true };
  }
  const release = await releaseManifest(env, job.toVersion);
  const source = await workerSource(env, release);
  const { token, accountId, scriptName } = await cloudflare(env);
  const settings = await scriptSettings(token, accountId, scriptName);
  await putScript(token, accountId, scriptName, scriptMetadata(settings, release), release.mainModule, source);
  // New requests may already reach the new code. This request still runs the old one, with the secrets in its env.
  await keepSecrets(env, token, accountId, scriptName);
  await ensureUpdateSchedule(token, accountId, scriptName).catch((err: unknown) =>
    console.error(
      JSON.stringify({ event: "update_schedule_failed", error: err instanceof Error ? err.message : String(err) }),
    ),
  );
  job.state.deployedAt = iso();
  job.message = `Waiting for Relaybase Worker ${job.toVersion} to answer`;
  return { done: true };
}

async function verify(env: Env, job: UpdateJob): Promise<StepResult> {
  if (BUILD_VERSION !== job.toVersion) {
    const since = Date.parse(job.state.deployedAt ?? job.updatedAt);
    if (Date.now() - since > VERIFY_TIMEOUT_MS) {
      throw new StepError(`Relaybase Worker ${job.toVersion} was uploaded but has not answered yet.`, "unverified");
    }
    job.message = `Waiting for Relaybase Worker ${job.toVersion} to answer`;
    return { done: false, waitMs: VERIFY_RETRY_MS };
  }
  await updateDb(env).prepare("SELECT 1 as ok").first();
  await env.INBOUND.list({ limit: 1 });
  await setMeta(env, "version", BUILD_VERSION);
  await setMeta(env, "updated_at", iso());
  job.message = null;
  return { done: true };
}

async function runStep(env: Env, job: UpdateJob): Promise<StepResult> {
  switch (job.step) {
    case "prepare":
      return prepare(env, job);
    case "migrate":
      return migrate(env, job);
    case "deploy":
      return deploy(env, job);
    case "verify":
      return verify(env, job);
  }
}

/** Run the job's current step if no other request holds it. */
export async function advanceJob(env: Env, jobId: string): Promise<{ job: UpdateJob; retryAfterMs?: number }> {
  const now = Date.now();
  const leased = await updateDb(env)
    .prepare(
      `UPDATE update_jobs SET lease_until = ?
       WHERE id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until < ?)`,
    )
    .bind(iso(now + LEASE_MS), jobId, iso(now))
    .run();
  const job = await getJob(env, jobId);
  if (!job) throw new Error("The update job is gone.");
  if (!leased.meta.changes) return { job, retryAfterMs: job.status === "running" ? BUSY_RETRY_MS : undefined };

  if (job.state.inStep) {
    job.state.interrupted = (job.state.interrupted ?? 0) + 1;
    if (job.state.interrupted > MAX_INTERRUPTED) {
      job.status = "failed";
      job.errorCode = "error";
      job.message = "The update kept stopping partway through this step.";
      job.state.inStep = undefined;
      job.leaseUntil = null;
      await saveJob(env, job);
      return { job };
    }
  }
  job.state.inStep = job.step;
  await saveJob(env, job);

  let retryAfterMs: number | undefined;
  try {
    const result = await runStep(env, job);
    job.errorCode = null;
    retryAfterMs = result.waitMs;
    if (result.done) {
      const next = STEPS.findIndex((step) => step.id === job.step) + 1;
      if (next >= STEPS.length) {
        job.status = "done";
        job.finishedAt = iso();
        job.message = null;
      } else {
        job.step = STEPS[next]!.id;
      }
    }
  } catch (err) {
    if (err instanceof StepWait) {
      retryAfterMs = err.ms;
      job.message = err.message;
    } else {
      const failure = classify(err);
      job.status = "failed";
      job.message = failure.message;
      job.errorCode = failure.code;
      console.error(JSON.stringify({ event: "update_step_failed", step: job.step, error: failure.message }));
    }
  }
  job.state.inStep = undefined;
  job.state.interrupted = 0;
  job.leaseUntil = null;
  await saveJob(env, job);
  return { job, retryAfterMs };
}

/** Resume a failed job where it stopped. */
export async function retryJob(env: Env, job: UpdateJob): Promise<UpdateJob | null> {
  const resumed = await updateDb(env)
    .prepare(
      `UPDATE update_jobs SET status = 'running', lease_until = NULL
       WHERE id = ? AND status = 'failed' AND NOT EXISTS (SELECT 1 FROM update_jobs WHERE status = 'running')`,
    )
    .bind(job.id)
    .run();
  if (!resumed.meta.changes) return null;
  if (job.step === "verify") job.state.deployedAt = iso();
  job.status = "running";
  job.message = null;
  job.errorCode = null;
  job.state.inStep = undefined;
  job.state.interrupted = 0;
  job.leaseUntil = null;
  await saveJob(env, job);
  return job;
}

/** Set a failed job aside, so the update is offered fresh. */
export async function cancelJob(env: Env, job: UpdateJob): Promise<UpdateJob | null> {
  const now = iso();
  await updateDb(env)
    .prepare(
      `UPDATE update_jobs SET status = 'cancelled', lease_until = NULL, updated_at = ?, finished_at = ?
       WHERE id = ? AND status = 'failed'`,
    )
    .bind(now, now, job.id)
    .run();
  return getJob(env, job.id);
}
