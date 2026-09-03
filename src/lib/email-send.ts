import type { Env, SendEmailBinding } from "../env";
import {
  type CfEmailSendResult,
  CloudflareClient,
} from "./cloudflare-client";
import { createCloudflareClient } from "./cloudflare-config";

export type SendOutboundParams = {
  from: string;
  fromName?: string;
  to: string | string[];
  cc?: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{
    content: string;
    filename: string;
    type: string;
    disposition: "attachment";
  }>;
  rawAttachments?: Array<{
    filename: string;
    contentType: string;
    content: ArrayBuffer;
  }>;
};

export function emailBindingConfigured(env: Env): boolean {
  return typeof env.EMAIL?.send === "function";
}

function namedOrPlain(
  address: string,
  name?: string,
): string | { email: string; name: string } {
  const trimmed = name?.trim();
  return trimmed ? { email: address, name: trimmed } : address;
}

async function sendViaBinding(
  email: SendEmailBinding,
  params: SendOutboundParams,
): Promise<CfEmailSendResult> {
  const headers: Record<string, string> = {};
  const inReplyTo = params.inReplyTo?.trim();
  const references = params.references?.trim();
  if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
  if (references) headers.References = references;

  const payload: Record<string, unknown> = {
    from: namedOrPlain(params.from, params.fromName),
    to: params.to,
    subject: params.subject,
    text: params.text,
  };
  if (params.cc) payload.cc = params.cc;
  const html = params.html?.trim();
  if (html) payload.html = html;
  const replyTo = params.replyTo?.trim();
  if (replyTo) payload.replyTo = replyTo;
  if (params.attachments?.length) payload.attachments = params.attachments;
  if (Object.keys(headers).length) payload.headers = headers;

  const result = await email.send(payload);
  return {
    messageId:
      result?.messageId?.trim() || `cf-email-${Date.now()}`,
    delivered: [],
    permanentBounces: [],
    queued: [],
  };
}

/**
 * Send via the Worker `EMAIL` binding when present; otherwise the REST
 * Email Sending API (`CF_API_TOKEN`). Binding accepts the message and
 * reports delivery asynchronously — bounce arrays stay empty here.
 */
export async function sendOutboundEmail(
  env: Env,
  params: SendOutboundParams,
): Promise<CfEmailSendResult> {
  if (emailBindingConfigured(env) && env.EMAIL) {
    return sendViaBinding(env.EMAIL, params);
  }
  const cf: CloudflareClient = await createCloudflareClient(env);
  return cf.sendEmail(params);
}
