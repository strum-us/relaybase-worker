/** Cloudflare Email Service send binding (`env.EMAIL.send()`). */
export type SendEmailBinding = {
  send(message: Record<string, unknown>): Promise<{ messageId?: string }>;
};

export type Env = {
  /** Mailbox R2 (`relaybase-mailbox`): inbound/{domain}/… and sent/{domain}/… */
  INBOUND: R2Bucket;
  /** Hosted Relaybase account only — product ops/send logs. */
  RELAYBASE_LOGS?: D1Database;
  /** Mailbox list/count/search index for inbound + sent (R2 stays source of truth). */
  RELAYBASE_MAIL?: D1Database;
  /** Durable product state (mailbox, audience, broadcasts, keys, tokens, …). */
  RELAYBASE_DB?: D1Database;
  /** Optional. Not required for mail or the Cloudflare API. */
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  /** Outbound Email Sending binding (`[[send_email]] name = "EMAIL"`). */
  EMAIL?: SendEmailBinding;
  /** Random pepper for owner passtoken + access-token HMAC. Set once at install. */
  AUTH_PEPPER?: string;
  WORKER_SCRIPT_NAME: string;
  INBOUND_BUCKET_NAME: string;
  /** Set in customer-install wrangler.toml [vars] at pack time. */
  WORKER_VERSION?: string;
};
