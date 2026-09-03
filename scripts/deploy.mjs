#!/usr/bin/env node
/**
 * Prefer wrangler.local.toml (dogfood IDs, gitignored) when present.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = existsSync(join(root, "wrangler.local.toml"))
  ? "wrangler.local.toml"
  : "wrangler.toml";

execFileSync("npx", ["wrangler", "deploy", "--config", config], {
  cwd: root,
  stdio: "inherit",
});
