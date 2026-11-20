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
  /** Cloudflare account that owns this Worker (set at install). */
  CF_ACCOUNT_ID?: string;
  /**
   * Cloudflare OAuth grant (src/lib/grant/cf-grant.ts): AES-GCM key (secret) for the stored
   * refresh token, and the OAuth client the refresh token belongs to. Set by the installer.
   */
  CF_GRANT_KEY?: string;
  CF_OAUTH_CLIENT_ID?: string;
  /** SHA-256 of the install setup code (secret); guards `/install/handoff`. */
  RELAYBASE_HANDOFF?: string;
  /** Release channel base URL for self-update, e.g. https://downloads.relaybase.email/release. */
  RELEASE_ORIGIN?: string;
  /** "1" in local dev: never redeploy itself. */
  RELAYBASE_DEV?: string;
  /** Outbound Email Sending binding (`[[send_email]] name = "EMAIL"`). */
  EMAIL?: SendEmailBinding;
  /** Random pepper for owner passtoken + access-token HMAC. Set once at install. */
  AUTH_PEPPER?: string;
  WORKER_SCRIPT_NAME: string;
  INBOUND_BUCKET_NAME: string;
  /** Set in packed wrangler.toml [vars] at pack time. */
  WORKER_VERSION?: string;
  /** Relaybase app (client `app/`) version this Worker build ships with. Reported in `/health` as `appVersion`. */
  APP_VERSION?: string;
};
