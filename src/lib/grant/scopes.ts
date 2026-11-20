/**
 * Cloudflare OAuth scopes each feature needs from the stored grant. The app
 * requests whatever the Relaybase OAuth client allows (console
 * `/api/v1/oauth/config`); a feature whose scopes the grant lacks reports
 * "Reconnect Cloudflare" instead of failing deep in an API call.
 */
export const CLOUDFLARE_FEATURE_SCOPES = {
  /** Replace this Worker's own script (self-update), read its settings and schedules. */
  selfUpdate: ["workers-scripts.write"],
  /** List zones, read and write DNS for mail domains. */
  domains: ["zone.read", "dns.write"],
  /** Email Routing: enable, rules, routing DNS. */
  emailRouting: ["email-routing.write"],
  /** Email Sending: subdomains and REST send fallback. */
  emailSending: ["email-sending.write"],
  /** D1 database sizes on /health and the console. */
  d1: ["d1.write"],
} as const;

export type CloudflareFeature = keyof typeof CLOUDFLARE_FEATURE_SCOPES;
