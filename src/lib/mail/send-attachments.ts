import type { R2Bucket } from "@cloudflare/workers-types";

import { getMailAttachment } from "../mailbox-store";

export type SendAttachmentInput = {
  filename: string;
  contentType: string;
  contentBase64?: string;
  source?: {
    kind: "inbound" | "sent";
    domain: string;
    messageId: string;
    attachmentId: string;
  };
};

export type ResolvedSendAttachment = {
  filename: string;
  contentType: string;
  content: ArrayBuffer;
  size: number;
};

export const MAX_SEND_MESSAGE_BYTES = 5 * 1024 * 1024;

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function resolveSendAttachments(
  bucket: R2Bucket,
  items: SendAttachmentInput[] | undefined,
): Promise<ResolvedSendAttachment[]> {
  if (!items?.length) return [];
  const resolved: ResolvedSendAttachment[] = [];
  for (const item of items) {
    const filename = item.filename?.trim();
    const contentType = item.contentType?.trim() || "application/octet-stream";
    if (!filename) {
      throw new Error("Attachment filename is required");
    }
    let content: ArrayBuffer;
    if (item.contentBase64?.trim()) {
      content = decodeBase64(item.contentBase64.trim());
    } else if (item.source) {
      const fromR2 = await getMailAttachment(bucket, item.source.kind, {
        domain: item.source.domain,
        messageId: item.source.messageId,
        attachmentId: item.source.attachmentId,
      });
      if (!fromR2) {
        throw new Error(`Attachment not found: ${filename}`);
      }
      content = fromR2.body;
    } else {
      throw new Error(`Attachment bytes missing: ${filename}`);
    }
    resolved.push({
      filename,
      contentType,
      content,
      size: content.byteLength,
    });
  }
  return resolved;
}

export function assertSendMessageSize(
  text: string,
  html: string | undefined,
  attachments: ResolvedSendAttachment[],
): void {
  const bodyBytes = new TextEncoder().encode(text).byteLength;
  const htmlBytes = html?.trim()
    ? new TextEncoder().encode(html).byteLength
    : 0;
  const attachmentBytes = attachments.reduce(
    (sum, item) => sum + item.size,
    0,
  );
  const estimated = bodyBytes + htmlBytes + attachmentBytes;
  if (estimated > MAX_SEND_MESSAGE_BYTES) {
    throw new Error(
      `Message exceeds ${MAX_SEND_MESSAGE_BYTES} byte limit (${estimated} bytes)`,
    );
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function attachmentsForEmailBinding(
  attachments: ResolvedSendAttachment[],
): Array<{
  content: string;
  filename: string;
  type: string;
  disposition: "attachment";
}> {
  return attachments.map((item) => ({
    content: arrayBufferToBase64(item.content),
    filename: item.filename,
    type: item.contentType,
    disposition: "attachment" as const,
  }));
}
