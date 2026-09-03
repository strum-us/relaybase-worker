import PostalMime, { decodeWords, type Address } from "postal-mime";

import { normalizeAttachmentBytes } from "./attachment-bytes.ts";

export function decodeMimeHeader(value: string | null | undefined): string {
  if (!value?.trim()) return "";
  return decodeWords(value).trim();
}

export type ParsedAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  disposition: string;
  contentId: string | null;
  content: ArrayBuffer;
};

export type ParsedInboundEmail = {
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  fromEmail: string;
  fromName: string;
  toEmails: string[];
  ccEmails: string[];
  attachments: ParsedAttachment[];
};

function collectAddresses(entries: Address[] | undefined): string[] {
  if (!entries?.length) return [];
  const seen = new Set<string>();
  const emails: string[] = [];
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

/**
 * Extract a single display sender (name + address) from a parsed `From`/`Sender`
 * address. postal-mime returns either a mailbox `{ name, address }` or a group
 * `{ name, group: Mailbox[] }`; for groups we take the first mailbox. Returns
 * empty strings when the header is absent so callers can fall back to the
 * envelope sender.
 */
function pickFromAddress(entry: Address | undefined): {
  name: string;
  address: string;
} {
  if (!entry) return { name: "", address: "" };
  if (entry.group?.length) {
    const first = entry.group[0];
    return {
      name: decodeMimeHeader(first?.name ?? "") || "",
      address: first?.address?.trim() ?? "",
    };
  }
  return {
    name: decodeMimeHeader(entry.name ?? "") || "",
    address: entry.address?.trim() ?? "",
  };
}

function attachmentBytes(content: Uint8Array | ArrayBuffer | string): ArrayBuffer {
  return normalizeAttachmentBytes(content);
}

function normalizeContentId(value: string | undefined | null): string | null {
  if (!value?.trim()) return null;
  return value.replace(/^<|>$/g, "").trim() || null;
}

export async function parseInboundMime(raw: ArrayBuffer): Promise<ParsedInboundEmail> {
  const parser = new PostalMime();
  const email = await parser.parse(raw);

  const attachments: ParsedAttachment[] = (email.attachments ?? []).map(
    (attachment, index) => {
      const content = attachmentBytes(attachment.content);
      return {
        id: String(index),
        filename:
          decodeMimeHeader(attachment.filename) || `attachment-${index + 1}`,
        contentType: attachment.mimeType?.trim() || "application/octet-stream",
        size: content.byteLength,
        disposition: attachment.disposition?.trim() || "attachment",
        contentId: normalizeContentId(attachment.contentId),
        content,
      };
    },
  );

  const subject =
    decodeMimeHeader(email.subject) ||
    decodeMimeHeader(email.headers.find((header) => header.key === "subject")?.value);

  const from = pickFromAddress(email.from ?? email.sender);

  return {
    subject,
    bodyText: email.text?.trim() ?? "",
    bodyHtml: email.html?.trim() || null,
    fromEmail: from.address,
    fromName: from.name,
    toEmails: collectAddresses(email.to),
    ccEmails: collectAddresses(email.cc),
    attachments,
  };
}
