import type { InboundEmailMeta } from "./mailbox-store";

/**
 * Minimal shape needed to aggregate counts — satisfied by both the full
 * `InboundEmailMeta` and the compact `InboundListEntry` index rows, so
 * counts can be computed from `_list.json` without loading any `meta.json`.
 */
export type InboundCountableMessage = Pick<
  InboundEmailMeta,
  "toEmail" | "toEmails" | "ccEmails" | "readAt"
>;

export type InboundAddressCounts = {
  total: number;
  unread: number;
};

export type InboundCountsResult = {
  counts: Record<string, InboundAddressCounts>;
  totalAll: number;
  unreadAll: number;
};

/**
 * Address membership for a message — same To + Cc rule as the desktop
 * client's `inboundMatchesAccount` (app/src/email/conversation-threading.ts),
 * kept here as a standalone copy since server code should not import `app/`.
 */
function messageAddresses(message: InboundCountableMessage): Set<string> {
  const addresses = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim().toLowerCase();
    if (trimmed) addresses.add(trimmed);
  };
  add(message.toEmail);
  for (const to of message.toEmails ?? []) add(to);
  for (const cc of message.ccEmails ?? []) add(cc);
  return addresses;
}

/** Per-address total/unread counts across every retained message for a domain. */
export function aggregateInboundCounts(
  messages: InboundCountableMessage[],
): InboundCountsResult {
  const counts: Record<string, InboundAddressCounts> = {};
  let totalAll = 0;
  let unreadAll = 0;

  for (const message of messages) {
    const unread = !message.readAt;
    totalAll += 1;
    if (unread) unreadAll += 1;

    for (const address of messageAddresses(message)) {
      const entry = counts[address] ?? { total: 0, unread: 0 };
      entry.total += 1;
      if (unread) entry.unread += 1;
      counts[address] = entry;
    }
  }

  return { counts, totalAll, unreadAll };
}
