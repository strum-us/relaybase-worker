import type { InboundEmailEvent } from "./inbound-events";
import { sha256Hex } from "./crypto";
import type { AppDb } from "../../db/app";
import {
  createWebhookRow as dbCreateWebhookRow,
  deleteWebhookRow as dbDeleteWebhookRow,
  deleteExpiredWebhookFails as dbDeleteExpiredWebhookFails,
  getWebhookSecret as dbGetWebhookSecret,
  listStoredWebhooks as dbListStoredWebhooks,
  listWebhooks as dbListWebhooks,
  recordWebhookFail as dbRecordWebhookFail,
  removeWebhookSecret as dbRemoveWebhookSecret,
  storeWebhookSecret as dbStoreWebhookSecret,
} from "../../db/app/webhooks";

const MAX_WEBHOOKS_PER_DOMAIN = 3;
const WEBHOOK_SECRET_PREFIX = "whsec_";
const FAIL_TTL_SECONDS = 7 * 24 * 60 * 60;

export type StoredWebhook = {
  id: string;
  domain: string;
  url: string;
  secretHash: string;
  createdAt: string;
  active: boolean;
};

export type WebhookRecord = Omit<StoredWebhook, "secretHash">;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  const encoded = btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${WEBHOOK_SECRET_PREFIX}${encoded}`;
}

export function isValidWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function listWebhooks(
  db: AppDb,
  domain: string,
): Promise<WebhookRecord[]> {
  return dbListWebhooks(db, domain);
}

export async function createWebhook(
  db: AppDb,
  params: { domain: string; url: string; secret?: string | null },
): Promise<{ webhook: WebhookRecord; secret: string }> {
  const domain = params.domain.trim().toLowerCase();
  const url = params.url.trim();
  if (!isValidWebhookUrl(url)) {
    throw new Error("url must be a valid http(s) URL");
  }

  const existing = await listWebhooks(db, domain);
  if (existing.length >= MAX_WEBHOOKS_PER_DOMAIN) {
    throw new Error(`maximum ${MAX_WEBHOOKS_PER_DOMAIN} webhooks per domain`);
  }

  const secret = params.secret?.trim() || generateWebhookSecret();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  await dbCreateWebhookRow(db, {
    id,
    domain,
    url,
    secretHash: await sha256Hex(secret),
  });
  await storeWebhookSecret(db, id, secret);
  return {
    webhook: { id, domain, url, createdAt, active: true },
    secret,
  };
}

export async function deleteWebhook(
  db: AppDb,
  domain: string,
  id: string,
): Promise<boolean> {
  // domain is used for scoping verification in the route layer; the FK
  // cascade handles secret + fail cleanup on delete.
  return dbDeleteWebhookRow(db, id);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function postWebhook(
  webhook: StoredWebhook,
  secret: string,
  event: InboundEmailEvent,
): Promise<boolean> {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${body}`;
  const signature = await hmacSha256Hex(secret, signedPayload);

  const res = await fetch(webhook.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Relaybase-Signature": `t=${timestamp},v1=${signature}`,
      "X-Relaybase-Event-Id": event.id,
      "X-Relaybase-Event-Type": event.type,
    },
    body,
  });

  return res.ok;
}

export async function deliverWebhooks(
  db: AppDb,
  domain: string,
  event: InboundEmailEvent,
): Promise<void> {
  const webhooks = await dbListStoredWebhooks(db, domain);
  const delays = [0, 1_000, 4_000, 16_000];

  for (const webhook of webhooks) {
    if (!webhook.active) continue;

    const secret = await dbGetWebhookSecret(db, webhook.id);
    if (!secret) continue;

    let delivered = false;
    for (const delay of delays) {
      if (delay > 0) await sleep(delay);
      try {
        if (await postWebhook(webhook, secret, event)) {
          delivered = true;
          break;
        }
      } catch (error) {
        console.error("Webhook delivery failed", webhook.url, error);
      }
    }

    if (!delivered) {
      const failedAt = new Date().toISOString();
      await dbRecordWebhookFail(db, {
        id: `${webhook.id}:${event.id}`,
        webhookId: webhook.id,
        eventId: event.id,
        url: webhook.url,
        failedAt,
        expiresAt: new Date(
          new Date(failedAt).getTime() + FAIL_TTL_SECONDS * 1000,
        ).toISOString(),
      });
    }
  }

  // Lazy cleanup of expired fail rows.
  await dbDeleteExpiredWebhookFails(db, new Date().toISOString());
}

export async function storeWebhookSecret(
  db: AppDb,
  webhookId: string,
  secret: string,
): Promise<void> {
  await dbStoreWebhookSecret(db, webhookId, secret);
}

export async function removeWebhookSecret(
  db: AppDb,
  webhookId: string,
): Promise<void> {
  await dbRemoveWebhookSecret(db, webhookId);
}
