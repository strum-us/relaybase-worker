#!/usr/bin/env node
/**
 * Prefer wrangler.local.toml (dogfood IDs, gitignored) when present.
 * Pins WORKER_VERSION to package.json on every deploy.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = existsSync(join(root, "wrangler.local.toml"))
  ? "wrangler.local.toml"
  : "wrangler.toml";

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const workerVersion = String(pkg.version ?? "").trim();
if (!workerVersion) {
  console.error("worker/package.json version is required for WORKER_VERSION");
  process.exit(1);
}

execFileSync(
  "npx",
  [
    "wrangler",
    "deploy",
    "--config",
    config,
    "--var",
    `WORKER_VERSION:${workerVersion}`,
  ],
  {
    cwd: root,
    stdio: "inherit",
  },
);
