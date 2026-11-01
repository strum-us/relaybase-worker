import type { Env, SendEmailBinding } from "../../env";
import {
  type CfEmailSendResult,
  CloudflareClient,
} from "../cloudflare/cloudflare-client";
import { createCloudflareClient } from "../cloudflare/cloudflare-config";
import {
  buildThreadingHeaders,
  isThreadingHeaderError,
  type ThreadingHeaders,
} from "./threading-headers.ts";

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

export type SendVia = "binding" | "rest_raw" | "rest_structured";

export type SendOutboundResult = CfEmailSendResult & {
  via: SendVia;
  threadingDropped: boolean;
  referencesCount: number;
  hasInReplyTo: boolean;
};

export class OutboundSendError extends Error {
  readonly via: SendVia;
  readonly threadingDropped: boolean;
  readonly referencesCount: number;
  readonly hasInReplyTo: boolean;

  constructor(
    message: string,
    meta: {
      via: SendVia;
      threadingDropped: boolean;
      referencesCount: number;
      hasInReplyTo: boolean;
    },
  ) {
    super(message);
    this.name = "OutboundSendError";
    this.via = meta.via;
    this.threadingDropped = meta.threadingDropped;
    this.referencesCount = meta.referencesCount;
    this.hasInReplyTo = meta.hasInReplyTo;
  }
}

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
  // The binding takes attachment `content` as raw binary (ArrayBuffer), unlike
  // the REST JSON endpoint which needs it pre-base64-encoded as a string —
  // passing a base64 string here made Cloudflare treat it as literal text and
  // re-encode it, landing a double-base64-encoded attachment at the recipient.
  if (params.rawAttachments?.length) {
    payload.attachments = params.rawAttachments.map((item) => ({
      filename: item.filename,
      content: item.content,
      type: item.contentType,
      disposition: "attachment" as const,
    }));
  }
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

function restVia(params: SendOutboundParams): Exclude<SendVia, "binding"> {
  const needsRaw = Boolean(
    params.fromName?.trim() ||
      params.inReplyTo?.trim() ||
      params.references?.trim() ||
      params.rawAttachments?.length,
  );
  return needsRaw ? "rest_raw" : "rest_structured";
}

function applyThreading(
  params: SendOutboundParams,
  threading: ThreadingHeaders,
): SendOutboundParams {
  return {
    ...params,
    inReplyTo: threading.inReplyTo,
    references: threading.references,
  };
}

async function deliver(
  env: Env,
  params: SendOutboundParams,
): Promise<{ result: CfEmailSendResult; via: SendVia }> {
  if (emailBindingConfigured(env) && env.EMAIL) {
    return { result: await sendViaBinding(env.EMAIL, params), via: "binding" };
  }
  const cf: CloudflareClient = await createCloudflareClient(env);
  return { result: await cf.sendEmail(params), via: restVia(params) };
}

function sendMeta(
  threading: ThreadingHeaders,
  via: SendVia,
  threadingDropped: boolean,
): {
  via: SendVia;
  threadingDropped: boolean;
  referencesCount: number;
  hasInReplyTo: boolean;
} {
  return {
    via,
    threadingDropped,
    referencesCount: threading.referencesCount,
    hasInReplyTo: threading.hasInReplyTo,
  };
}

function asOutboundError(
  error: unknown,
  meta: {
    via: SendVia;
    threadingDropped: boolean;
    referencesCount: number;
    hasInReplyTo: boolean;
  },
): OutboundSendError {
  if (error instanceof OutboundSendError) return error;
  const message = error instanceof Error ? error.message : "Failed to send email";
  return new OutboundSendError(message, meta);
}

/**
 * Send via the Worker `EMAIL` binding when present; otherwise the REST
 * Email Sending API (`CF_API_TOKEN`). Binding accepts the message and
 * reports delivery asynchronously — bounce arrays stay empty here.
 *
 * Threading headers are normalized first. If Cloudflare rejects those
 * headers, the send is retried once without them.
 */
export async function sendOutboundEmail(
  env: Env,
  params: SendOutboundParams,
): Promise<SendOutboundResult> {
  const threading = buildThreadingHeaders(params);
  const prepared = applyThreading(params, threading);
  const attached = Boolean(threading.inReplyTo || threading.references);
  const viaGuess: SendVia = emailBindingConfigured(env)
    ? "binding"
    : restVia(prepared);
  try {
    const { result, via } = await deliver(env, prepared);
    return { ...result, ...sendMeta(threading, via, false) };
  } catch (error) {
    if (!attached || !isThreadingHeaderError(error)) {
      throw asOutboundError(error, sendMeta(threading, viaGuess, false));
    }
    try {
      const retry = await deliver(env, {
        ...params,
        inReplyTo: undefined,
        references: undefined,
      });
      return { ...retry.result, ...sendMeta(threading, retry.via, true) };
    } catch (retryError) {
      throw asOutboundError(retryError, sendMeta(threading, viaGuess, false));
    }
  }
}
