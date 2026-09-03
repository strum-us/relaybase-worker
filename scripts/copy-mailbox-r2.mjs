#!/usr/bin/env node
/**
 * Copy relaybase-inbound → relaybase-mailbox using a short-lived Worker so
 * objects never leave Cloudflare (R2 cannot rename buckets).
 *
 * Prerequisite: in-place sent/_sendlog layout already applied on the source
 * (see migrate-mailbox-r2.mjs).
 *
 * Usage (from server/):
 *   node scripts/copy-mailbox-r2.mjs              # dry-run (create bucket only listed)
 *   node scripts/copy-mailbox-r2.mjs --apply
 *
 * Requires CLOUDFLARE_API_TOKEN. After a successful copy, bind the product
 * Worker to relaybase-mailbox and deploy.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(__dirname, "..");
const WRANGLER_TOML = join(SERVER_DIR, "wrangler.toml");
const COPY_DIR = join(__dirname, "mailbox-copy-worker");
const COPY_WORKER = "relaybase-mailbox-copy";

const APPLY = process.argv.includes("--apply");
const SOURCE_BUCKET = "relaybase-inbound";
const DEST_BUCKET = "relaybase-mailbox";

function accountIdFromWranglerToml() {
  let text;
  try {
    text = readFileSync(WRANGLER_TOML, "utf8");
  } catch {
    return null;
  }
  const head = text.split(/\n\[\[/)[0];
  const match = head.match(/account_id\s*=\s*"([^"]+)"/);
  return match ? match[1] : null;
}

const ACCOUNT_ID =
  process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ||
  accountIdFromWranglerToml() ||
  "";

function wranglerOauthToken() {
  const candidates = [
    join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
    join(homedir(), ".wrangler/config/default.toml"),
    join(homedir(), ".config/wrangler/default.toml"),
  ];
  for (const path of candidates) {
    try {
      const text = readFileSync(path, "utf8");
      const match = text.match(/oauth_token\s*=\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    } catch {
      // try next
    }
  }
  return null;
}

function apiToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const oauth = wranglerOauthToken();
  if (oauth) return oauth;
  throw new Error("CLOUDFLARE_API_TOKEN is required (or wrangler login)");
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${apiToken()}`, ...extra };
}

function cfApi(path) {
  return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}${path}`;
}

async function cfJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: authHeaders(init.headers) });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  if (!res.ok || body.success === false) {
    const err = body.errors?.[0]?.message || text.slice(0, 300);
    throw new Error(`${init.method || "GET"} ${url} failed (${res.status}): ${err}`);
  }
  return body;
}

async function listBuckets() {
  const listed = await cfJson(cfApi("/r2/buckets"));
  const buckets = listed.result?.buckets ?? listed.result ?? [];
  return Array.isArray(buckets)
    ? buckets.map((b) => (typeof b === "string" ? b : b.name)).filter(Boolean)
    : [];
}

async function ensureBucket(name) {
  const names = await listBuckets();
  if (names.includes(name)) {
    console.log(`bucket ${name} already exists`);
    return;
  }
  if (!APPLY) {
    console.log(`DRY-RUN would create bucket ${name}`);
    return;
  }
  await cfJson(cfApi("/r2/buckets"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  console.log(`created bucket ${name}`);
}

async function listR2Count(bucket) {
  let n = 0;
  let cursor;
  do {
    const params = new URLSearchParams({ per_page: "1000" });
    if (cursor) params.set("cursor", cursor);
    const body = await cfJson(
      cfApi(`/r2/buckets/${bucket}/objects?${params.toString()}`),
    );
    const objects =
      body.result?.objects ??
      (Array.isArray(body.result) ? body.result : []);
    n += objects.length;
    const info = body.result_info ?? body.result ?? {};
    cursor =
      info.cursor && (info.is_truncated || info.truncated) ? info.cursor : undefined;
    if (!cursor && body.result?.truncated && body.result?.cursor) {
      cursor = body.result.cursor;
    }
  } while (cursor);
  return n;
}

function wrangler(args, { stdin } = {}) {
  return execFileSync(
    "pnpm",
    ["exec", "wrangler", "--config", join(COPY_DIR, "wrangler.toml"), ...args],
    {
      cwd: SERVER_DIR,
      encoding: "utf8",
      input: stdin,
      stdio: stdin === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      env: process.env,
    },
  );
}

function parseWorkersDevUrl(deployOutput) {
  const match = deployOutput.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
  return match ? match[0].replace(/\/$/, "") : null;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWorker(baseUrl) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const res = await fetch(baseUrl);
      if (res.status === 401 || res.status === 200) return;
    } catch {
      // DNS / connection not ready yet
    }
    console.log(`  waiting for copy worker (attempt ${attempt})…`);
    await sleep(1000);
  }
  throw new Error("copy worker never became reachable");
}

async function copyViaWorker(baseUrl, secret) {
  let cursor = "";
  let total = 0;
  let batches = 0;
  for (;;) {
    const url = new URL(baseUrl);
    url.searchParams.set("secret", secret);
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, {
      headers: { "x-migrate-secret": secret },
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 404) {
      console.log("  copy worker 404, retrying…");
      await sleep(1000);
      continue;
    }
    if (!res.ok) {
      throw new Error(
        `copy batch failed (${res.status}): ${body.error || JSON.stringify(body).slice(0, 200)}`,
      );
    }
    total += Number(body.copied) || 0;
    batches += 1;
    console.log(
      `  batch ${batches} copied=${body.copied} listed=${body.listed} total=${total} done=${body.done}`,
    );
    if (body.done) break;
    if (!body.cursor) {
      throw new Error("copy worker returned truncated without cursor");
    }
    cursor = body.cursor;
  }
  return total;
}

async function deleteCopyWorker() {
  try {
        wrangler(["delete", "--name", COPY_WORKER, "--force"], { stdin: "y\n" });
    console.log(`deleted worker ${COPY_WORKER}`);
  } catch (error) {
    console.error(
      `could not delete ${COPY_WORKER}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

async function main() {
  if (!ACCOUNT_ID) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  }
  apiToken();
  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} ${SOURCE_BUCKET} → ${DEST_BUCKET} (Worker copy)`);
  await ensureBucket(DEST_BUCKET);
  const srcCount = await listR2Count(SOURCE_BUCKET);
  console.log(`source objects=${srcCount}`);
  if (!APPLY) {
    console.log("DRY-RUN would deploy relaybase-mailbox-copy, copy, then delete that Worker");
    return;
  }

  const secret = randomBytes(24).toString("hex");
  console.log(`deploying ${COPY_WORKER}…`);
  const deployOut = wrangler(["deploy", "--var", `MIGRATE_SECRET:${secret}`]);
  process.stdout.write(deployOut);
  const baseUrl = parseWorkersDevUrl(deployOut);
  if (!baseUrl) {
    throw new Error("could not parse workers.dev URL from wrangler deploy");
  }
  console.log(`copying via ${baseUrl}…`);
  try {
    await waitForWorker(baseUrl);
    const copied = await copyViaWorker(baseUrl, secret);
    const dstCount = await listR2Count(DEST_BUCKET);
    console.log(`copied=${copied} dest objects=${dstCount} source objects=${srcCount}`);
    if (dstCount < srcCount) {
      throw new Error(
        `destination has fewer objects than source (${dstCount} < ${srcCount})`,
      );
    }
  } finally {
    await deleteCopyWorker();
  }
  console.log(
    "Next: set server/wrangler.toml bucket_name + INBOUND_BUCKET_NAME to relaybase-mailbox, then wrangler deploy. Delete relaybase-inbound after verifying mail.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
