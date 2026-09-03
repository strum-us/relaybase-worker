#!/usr/bin/env node
/**
 * Import a Gmail Takeout mbox into relaybase-mailbox as inbound/{domain}/{id}/
 * (and sent/{domain}/_list.json for Sent-labeled messages).
 *
 * ⚠️  DOGFOODING / REFERENCE ONLY — NOT A PRODUCTION CODE PATH.
 *
 * This script is kept only as a reference for the future production Gmail
 * Takeout import feature. It is NOT used by the hosted Worker, the desktop
 * app, or any customer install. Do not run it against a live mailbox you
 * care about:
 *
 *   - It reads `inbound/{domain}/_list.json` once into memory and overwrites
 *     it whole-file at the end (`flushListIndex`). Messages received via the
 *     live Worker ingest path while the script runs are in R2 but get
 *     dropped from the in-memory snapshot, so the final overwrite silently
 *     evicts them from `_list.json`. This is exactly how the 2026-08-18
 *     wedesk.so inbox gap happened.
 *   - It writes R2 objects directly and never touches the D1 FTS search
 *     index, so imported mail is invisible to server-side search until a
 *     backfill/reconcile runs.
 *
 * The Worker's `ensureListIndex` (server/src/lib/inbound-store.ts) owns the
 * compact index and now self-heals drift on read and via the inbound index
 * cron. Any future production import must go through the Worker's store
 * helpers (or at minimum merge into the existing `_list.json` and sync D1),
 * never overwrite it from a stale snapshot.
 *
 * Usage (from server/):
 *   node scripts/import-mbox.mjs
 *   node scripts/import-mbox.mjs --apply
 *   node scripts/import-mbox.mjs --mbox /path/to/file.mbox --email isaac@wedesk.so --apply
 *
 * Requires CLOUDFLARE_API_TOKEN (or wrangler login token in the environment)
 * and CLOUDFLARE_ACCOUNT_ID (defaults to server/wrangler.toml).
 */

import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import PostalMime, { decodeWords } from "postal-mime";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRANGLER_TOML = join(__dirname, "..", "wrangler.toml");

const APPLY = process.argv.includes("--apply");
const SENT_ONLY = process.argv.includes("--sent-index");
const LOCAL_SENT_PATH = argValue(
  "--local-sent",
  join(homedir(), ".relaybase/mail/desktop/sent.json"),
);
const DEFAULT_MBOX =
  "/Users/isaaclee/operation/33.wedesk.so/Takeout/Mail/All mail Including Spam and Trash.mbox";
const DEFAULT_EMAIL = "isaac@wedesk.so";
const BUCKET = "relaybase-mailbox";

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
const CONCURRENCY = 6;
const SKIP_LABELS = new Set(["spam", "trash", "drafts"]);

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const MBOX_PATH = resolve(argValue("--mbox", DEFAULT_MBOX));
const MAILBOX_EMAIL = argValue("--email", DEFAULT_EMAIL).trim().toLowerCase();
const DOMAIN = MAILBOX_EMAIL.includes("@")
  ? MAILBOX_EMAIL.slice(MAILBOX_EMAIL.indexOf("@") + 1)
  : "";

function decodeHeader(value) {
  if (!value?.trim()) return "";
  try {
    return decodeWords(value).trim();
  } catch {
    return value.trim();
  }
}

function previewText(text, max = 500) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function normalizeMessageId(raw) {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const unwrapped =
    trimmed.startsWith("<") && trimmed.endsWith(">")
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return unwrapped || null;
}

function headerValue(raw, name) {
  const re = new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\r?\\n\\S|\\r?\\n\\r?\\n)`, "im");
  const match = raw.match(re);
  if (!match) return "";
  return match[1].replace(/\r?\n[ \t]+/g, " ").trim();
}

function gmailLabels(raw) {
  const value = headerValue(raw, "X-Gmail-Labels");
  if (!value) return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function shouldSkipLabels(labels) {
  return labels.some((label) => SKIP_LABELS.has(label.toLowerCase()));
}

function isSentLabel(labels) {
  return labels.some((label) => label.toLowerCase() === "sent");
}

function sentIdFromMessageId(normalized, fallback) {
  if (!normalized) return fallback;
  return `takeout-${createHash("sha1").update(normalized).digest("hex").slice(0, 16)}`;
}

function splitMbox(buffer) {
  const text = buffer.toString("utf8");
  const parts = text.split(/^From /m);
  const messages = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const nl = part.indexOf("\n");
    const body = nl >= 0 ? part.slice(nl + 1) : "";
    if (!body.trim()) continue;
    messages.push(body.replace(/^\r?\n/, ""));
  }
  return messages;
}

function safeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

function receivedAtFromRaw(raw, fallbackIso) {
  const dateHeader = headerValue(raw, "Date");
  if (dateHeader) {
    const parsed = new Date(dateHeader);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallbackIso;
}

function collectAddresses(entries) {
  if (!entries?.length) return [];
  const seen = new Set();
  const emails = [];
  for (const entry of entries) {
    const mailboxes = entry.group?.length
      ? entry.group
      : entry.address
        ? [{ name: entry.name, address: entry.address }]
        : [];
    for (const mailbox of mailboxes) {
      const address = mailbox.address?.trim();
      if (!address) continue;
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      emails.push(address);
    }
  }
  return emails;
}

function pickFrom(entry) {
  if (!entry) return { name: "", address: "" };
  if (entry.group?.length) {
    const first = entry.group[0];
    return {
      name: decodeHeader(first?.name ?? ""),
      address: first?.address?.trim() ?? "",
    };
  }
  return {
    name: decodeHeader(entry.name ?? ""),
    address: entry.address?.trim() ?? "",
  };
}

function attachmentBytes(content) {
  if (typeof content === "string") {
    return Buffer.from(content);
  }
  if (content instanceof ArrayBuffer) return Buffer.from(content);
  return Buffer.from(content);
}

async function parseMime(rawText) {
  const parser = new PostalMime();
  const email = await parser.parse(rawText);
  const attachments = (email.attachments ?? []).map((attachment, index) => {
    const content = attachmentBytes(attachment.content);
    return {
      id: String(index),
      filename: decodeHeader(attachment.filename) || `attachment-${index + 1}`,
      contentType: attachment.mimeType?.trim() || "application/octet-stream",
      size: content.byteLength,
      disposition: attachment.disposition?.trim() || "attachment",
      contentId: attachment.contentId?.replace(/^<|>$/g, "").trim() || null,
      content,
    };
  });
  const from = pickFrom(email.from ?? email.sender);
  return {
    subject:
      decodeHeader(email.subject) ||
      decodeHeader(headerValue(rawText, "Subject")) ||
      "(no subject)",
    bodyText: email.text?.trim() ?? "",
    bodyHtml: email.html?.trim() || null,
    fromEmail: from.address,
    fromName: from.name,
    toEmails: collectAddresses(email.to),
    ccEmails: collectAddresses(email.cc),
    attachments,
  };
}

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
  throw new Error(
    "CLOUDFLARE_API_TOKEN is required for --apply (or wrangler login)",
  );
}

function objectUrl(key) {
  return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key).replaceAll("%2F", "/")}`;
}

async function r2Put(key, body, contentType) {
  let lastError = "";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const res = await fetch(objectUrl(key), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken()}`,
        "Content-Type": contentType,
      },
      body,
    });
    if (res.ok) return;
    lastError = `${res.status} ${(await res.text()).slice(0, 200)}`;
    if (res.status < 500 && res.status !== 429) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 400 * attempt));
  }
  throw new Error(`R2 PUT ${key} failed: ${lastError}`);
}

async function r2GetText(key) {
  const res = await fetch(objectUrl(key), {
    headers: { Authorization: `Bearer ${apiToken()}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 GET ${key} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.text();
}

async function mapPool(items, limit, worker) {
  const out = [];
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

function listEntryFromMeta(meta) {
  const { bodyText, bodyHtml, ...rest } = meta;
  return rest;
}

function compactListMessages(messages) {
  const deduped = [];
  const seenIds = new Set();
  const seenRfc = new Set();
  for (const entry of [...messages].sort((a, b) =>
    b.receivedAt.localeCompare(a.receivedAt),
  )) {
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    const rfc = normalizeMessageId(entry.messageId);
    if (rfc) {
      if (seenRfc.has(rfc)) continue;
      seenRfc.add(rfc);
    }
    deduped.push(entry);
  }
  return deduped;
}

async function flushListIndex(messages) {
  const deduped = compactListMessages(messages);
  await r2Put(
    `inbound/${DOMAIN}/_list.json`,
    JSON.stringify({ version: 1, messages: deduped }),
    "application/json",
  );
  return deduped;
}

function mergeLocalSent(sent) {
  let existing = [];
  try {
    const raw = readFileSync(LOCAL_SENT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.sent)) existing = parsed.sent;
  } catch {
    // first write
  }
  const byId = new Map();
  for (const item of existing) {
    if (item?.id) byId.set(item.id, item);
  }
  for (const item of sent) {
    byId.set(item.id, existing.find((row) => row.id === item.id) ?? item);
  }
  const next = [...byId.values()].sort((a, b) =>
    String(b.sentAt ?? "").localeCompare(String(a.sentAt ?? "")),
  );
  writeFileSync(LOCAL_SENT_PATH, JSON.stringify({ sent: next }, null, 2));
  return next.length;
}

async function writeSentIndex(sent) {
  await r2Put(
    `sent/${DOMAIN}/_list.json`,
    JSON.stringify({ version: 1, messages: sent }),
    "application/json",
  );
  const localCount = mergeLocalSent(sent);
  console.log(`sent index=${sent.length} localSent=${localCount} path=${LOCAL_SENT_PATH}`);
}

async function main() {
  if (!DOMAIN) {
    throw new Error(`Invalid mailbox email: ${MAILBOX_EMAIL}`);
  }
  if (APPLY && !ACCOUNT_ID) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID is required for --apply (or set account_id in server/wrangler.toml)",
    );
  }

  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} ${MBOX_PATH}`);
  console.log(`mailbox=${MAILBOX_EMAIL} domain=${DOMAIN} bucket=${BUCKET}`);

  const rawFile = readFileSync(MBOX_PATH);
  const chunks = splitMbox(rawFile);
  console.log(`mbox messages: ${chunks.length}`);

  const stats = {
    imported: 0,
    skippedLabel: 0,
    skippedDup: 0,
    skippedParse: 0,
    labels: Object.create(null),
  };
  const prepared = [];
  const sentPrepared = [];
  const seenMessageIds = new Set();
  let fallbackTick = 0;

  for (const raw of chunks) {
    const labels = gmailLabels(raw);
    for (const label of labels) {
      stats.labels[label] = (stats.labels[label] ?? 0) + 1;
    }
    if (shouldSkipLabels(labels)) {
      stats.skippedLabel += 1;
      continue;
    }

    const messageId = headerValue(raw, "Message-ID") || headerValue(raw, "Message-Id");
    const normalized = normalizeMessageId(messageId);
    if (normalized) {
      if (seenMessageIds.has(normalized)) {
        stats.skippedDup += 1;
        continue;
      }
      seenMessageIds.add(normalized);
    }

    let parsed;
    try {
      parsed = await parseMime(raw);
    } catch (error) {
      stats.skippedParse += 1;
      console.warn("parse failed", error instanceof Error ? error.message : error);
      continue;
    }

    fallbackTick += 1;
    const receivedAt = receivedAtFromRaw(
      raw,
      new Date(Date.now() - fallbackTick * 1000).toISOString(),
    );
    const id = randomUUID();
    const toEmails = parsed.toEmails.length ? parsed.toEmails : [MAILBOX_EMAIL];
    const meta = {
      id,
      domain: DOMAIN,
      fromEmail: parsed.fromEmail || MAILBOX_EMAIL,
      fromName: parsed.fromName,
      toEmail: MAILBOX_EMAIL,
      toEmails,
      ccEmails: parsed.ccEmails,
      subject: parsed.subject,
      receivedAt,
      messageId: messageId || null,
      inReplyTo: headerValue(raw, "In-Reply-To") || null,
      references: headerValue(raw, "References") || null,
      size: Buffer.byteLength(raw),
      bodyPreview: previewText(parsed.bodyText || parsed.subject),
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
      attachments: parsed.attachments.map(({ content, ...rest }) => rest),
      readAt: receivedAt,
    };

    prepared.push({
      id,
      normalized,
      raw,
      meta,
      attachments: parsed.attachments,
    });
    if (isSentLabel(labels)) {
      sentPrepared.push({
        id: sentIdFromMessageId(normalized, id),
        from: parsed.fromEmail || MAILBOX_EMAIL,
        to: toEmails.join(", "),
        cc: parsed.ccEmails.length ? parsed.ccEmails.join(", ") : undefined,
        subject: parsed.subject,
        bodyPreview: previewText(parsed.bodyText || parsed.subject),
        sentAt: receivedAt,
        messageId: messageId || undefined,
        inReplyTo: headerValue(raw, "In-Reply-To") || undefined,
        references: headerValue(raw, "References") || undefined,
      });
    }
    stats.imported += 1;
  }

  prepared.sort((a, b) => b.meta.receivedAt.localeCompare(a.meta.receivedAt));

  sentPrepared.sort((a, b) => b.sentAt.localeCompare(a.sentAt));

  console.log("label counts:", stats.labels);
  console.log(
    `import=${stats.imported} skipLabel=${stats.skippedLabel} skipDup=${stats.skippedDup} skipParse=${stats.skippedParse} sent=${sentPrepared.length}`,
  );

  if (!APPLY) {
    console.log("dry-run only — pass --apply to upload to R2");
    return;
  }

  if (SENT_ONLY) {
    await writeSentIndex(sentPrepared);
    return;
  }

  const listKey = `inbound/${DOMAIN}/_list.json`;
  const existingIndexRaw = await r2GetText(listKey);
  const existingIndex = existingIndexRaw
    ? JSON.parse(existingIndexRaw)
    : { version: 1, messages: [] };
  const existingByMessageId = new Map();
  for (const entry of existingIndex.messages ?? []) {
    const rfc = normalizeMessageId(entry.messageId);
    if (rfc) existingByMessageId.set(rfc, entry.id);
  }

  let uploaded = 0;
  let skippedExisting = 0;
  const listMessages = [...(existingIndex.messages ?? [])];

  await mapPool(prepared, CONCURRENCY, async (item) => {
    try {
      if (item.normalized) {
        let existingId = existingByMessageId.get(item.normalized);
        if (!existingId) {
          existingId = await r2GetText(
            `inbound/${DOMAIN}/by-message-id/${encodeURIComponent(item.normalized)}`,
          );
        }
        if (existingId) {
          existingByMessageId.set(item.normalized, existingId);
          if (!listMessages.some((entry) => entry.id === existingId)) {
            const metaRaw = await r2GetText(
              `inbound/${DOMAIN}/${existingId}/meta.json`,
            );
            if (metaRaw) {
              listMessages.push(listEntryFromMeta(JSON.parse(metaRaw)));
            }
          }
          skippedExisting += 1;
          return;
        }
      }
      const prefix = `inbound/${DOMAIN}/${item.id}`;
      await r2Put(`${prefix}/meta.json`, JSON.stringify(item.meta), "application/json");
      await r2Put(`${prefix}/raw.eml`, item.raw, "message/rfc822");
      for (const attachment of item.attachments) {
        const key = `${prefix}/attachments/${attachment.id}-${safeFilename(attachment.filename)}`;
        await r2Put(key, attachment.content, attachment.contentType);
      }
      if (item.normalized) {
        await r2Put(
          `inbound/${DOMAIN}/by-message-id/${encodeURIComponent(item.normalized)}`,
          item.id,
          "text/plain",
        );
        existingByMessageId.set(item.normalized, item.id);
      }
      listMessages.push(listEntryFromMeta(item.meta));
      uploaded += 1;
      if (uploaded % 50 === 0) {
        console.log(`uploaded ${uploaded}/${prepared.length}`);
      }
      if (uploaded > 0 && uploaded % 100 === 0) {
        await flushListIndex(listMessages);
      }
    } catch (error) {
      console.error(
        `item ${item.id} failed:`,
        error instanceof Error ? error.message : error,
      );
      throw error;
    }
  });

  const deduped = await flushListIndex(listMessages);
  await writeSentIndex(sentPrepared);

  console.log(
    `done uploaded=${uploaded} skippedExisting=${skippedExisting} list=${deduped.length} sent=${sentPrepared.length}`,
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
