import {
  cloudflarePermissionHint,
  cloudflareSendingErrorHint,
} from "./cloudflare-api-hints.ts";
import { normalizeCfAccountId } from "./cf-account-id.ts";
import {
  mapCfZoneRow,
  zoneBelongsToPinnedAccount,
  zonesListQuery,
  zonesOnPinnedAccount,
  type CfListedZone,
} from "./cloudflare-zones.ts";
import { buildMimeMessage } from "./mime.ts";

const API_BASE = "https://api.cloudflare.com/client/v4";

type CfResponse<T> = {
  success: boolean;
  errors?: Array<{ code?: number; message: string }>;
  result: T;
};

type CfLooseErrorBody = {
  code?: number;
  error?: string;
  message?: string;
  errors?: Array<{ code?: number; message: string }>;
  success?: boolean;
  result?: unknown;
};

function normalizeCfResponse<T>(raw: CfLooseErrorBody): CfResponse<T> {
  if (Array.isArray(raw.errors) || typeof raw.success === "boolean") {
    return raw as CfResponse<T>;
  }

  if (raw.code != null) {
    return {
      success: false,
      errors: [
        {
          code: raw.code,
          message: raw.error ?? raw.message ?? "Unknown error",
        },
      ],
      result: null as T,
    };
  }

  return {
    success: false,
    errors: [{ message: raw.error ?? raw.message ?? "Unknown error" }],
    result: null as T,
  };
}

export type CfEmailSendResult = {
  messageId: string;
  delivered: string[];
  permanentBounces: string[];
  queued: string[];
};

export type CfEmailRoutingSettings = {
  enabled: boolean;
};

export type CfDnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  priority?: number;
};

export type CfEmailRoutingAction = {
  type: "forward" | "drop" | "worker";
  value?: string[];
};

export type CfEmailRoutingMatcher = {
  type: "literal" | "all";
  field?: "to";
  value?: string;
};

export type CfEmailRoutingRule = {
  id: string;
  enabled: boolean;
  matchers: CfEmailRoutingMatcher[];
  actions: CfEmailRoutingAction[];
};

export type CfSendingSubdomain = {
  enabled: boolean;
  name: string;
  tag?: string;
  return_path_domain?: string;
};

export type CloudflareClientCredentials = {
  /** Optional — resolved from the token when an account-scoped path is used. */
  accountId?: string;
  apiToken: string;
};

export class CloudflareClient {
  public readonly accountId: string;
  private apiToken: string;

  constructor(credentials: CloudflareClientCredentials) {
    this.accountId = normalizeCfAccountId(credentials.accountId) ?? "";
    this.apiToken = credentials.apiToken;
  }

  private async requireAccountId(): Promise<string> {
    if (this.accountId) return this.accountId;
    throw new Error(
      "Cloudflare account is not pinned. REST Email Sending needs CF_ACCOUNT_ID, D1 owner_config.cf_account_id, or the connected desktop accountId — it must not guess from GET /zones.",
    );
  }

  private tokenHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async requestOnce<T>(
    path: string,
    init: RequestInit | undefined,
  ): Promise<{ res: Response; data: CfResponse<T> }> {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...this.tokenHeaders(), ...init?.headers },
    });
    let raw: CfLooseErrorBody;
    try {
      raw = (await res.json()) as CfLooseErrorBody;
    } catch {
      raw = { error: `HTTP ${res.status}` };
    }
    const data = normalizeCfResponse<T>(raw);
    return { res, data };
  }

  private formatCfError(
    res: Response,
    data: CfResponse<unknown>,
    path: string,
    method?: string,
  ): Error {
    const details =
      data.errors
        ?.map((e) =>
          e.code != null ? `[${e.code}] ${e.message}` : e.message,
        )
        .join("; ") || `HTTP ${res.status}`;

    const isAuthError =
      res.status === 401 ||
      res.status === 403 ||
      data.errors?.some(
        (e) =>
          e.code === 10000 ||
          e.code === 10101 ||
          e.code === 10102 ||
          e.code === 10103 ||
          e.message?.toLowerCase().includes("authentication") ||
          e.message?.toLowerCase().includes("unauthorized"),
      );

    const lines = [`Cloudflare API: ${details}`, `API: ${(method ?? "GET").toUpperCase()} ${path}`];

    if (isAuthError) {
      const hint = cloudflarePermissionHint(path, method ?? "GET");
      if (hint) lines.push("", hint);
    } else {
      const sendingHint = cloudflareSendingErrorHint(data.errors);
      if (sendingHint) lines.push("", sendingHint);
    }

    return new Error(lines.join("\n"));
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<CfResponse<T>> {
    const { res, data } = await this.requestOnce<T>(path, init);
    if (res.ok && data.success) return data;
    throw this.formatCfError(res, data, path, init?.method ?? "GET");
  }

  private async sendWithRetry<T>(
    path: string,
    init: RequestInit,
  ): Promise<CfResponse<T>> {
    const maxAttempts = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.request<T>(path, init);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryable =
          lastError.message.includes("[10002]") ||
          lastError.message.includes("[10100]");
        if (!retryable || attempt === maxAttempts - 1) throw lastError;
        await this.sleep(1500 * (attempt + 1));
      }
    }

    throw lastError ?? new Error("Cloudflare Email Sending request failed");
  }

  private mapSendResult(data: CfResponse<{
    message_id: string;
    delivered: string[];
    permanent_bounces: string[];
    queued: string[];
  }>): CfEmailSendResult {
    return {
      messageId:
        data.result.message_id ??
        `cf-${data.result.delivered?.[0] ?? data.result.queued?.[0] ?? "sent"}-${Date.now()}`,
      delivered: data.result.delivered ?? [],
      permanentBounces: data.result.permanent_bounces ?? [],
      queued: data.result.queued ?? [],
    };
  }

  private async sendStructuredEmail(params: {
    from: string;
    fromName?: string;
    to: string | string[];
    cc?: string | string[];
    subject: string;
    text: string;
    html?: string;
    replyTo?: string;
    attachments?: Array<{
      content: string;
      filename: string;
      type: string;
      disposition: "attachment";
    }>;
  }): Promise<CfEmailSendResult> {
    const fromAddress = params.from.trim();
    const fromName = params.fromName?.trim();
    const body: Record<string, unknown> = {
      from: fromName
        ? { address: fromAddress, name: fromName }
        : fromAddress,
      to: params.to,
      subject: params.subject,
      text: params.text,
    };
    if (params.cc) body.cc = params.cc;
    const html = params.html?.trim();
    if (html) body.html = html;
    const replyTo = params.replyTo?.trim();
    if (replyTo) body.reply_to = replyTo;
    if (params.attachments?.length) body.attachments = params.attachments;

    const accountId = await this.requireAccountId();
    const path = `/accounts/${accountId}/email/sending/send`;
    const data = await this.sendWithRetry<{
      message_id: string;
      delivered: string[];
      permanent_bounces: string[];
      queued: string[];
    }>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return this.mapSendResult(data);
  }

  private async sendRawEmail(params: {
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
      filename: string;
      contentType: string;
      content: ArrayBuffer;
    }>;
  }): Promise<CfEmailSendResult> {
    const fromAddress = params.from.trim();
    const toList = Array.isArray(params.to) ? params.to : [params.to];
    const ccList = params.cc
      ? Array.isArray(params.cc)
        ? params.cc
        : [params.cc]
      : [];
    const recipients = [...toList, ...ccList]
      .map((address) => address.trim())
      .filter(Boolean);
    const mimeMessage = buildMimeMessage({
      from: fromAddress,
      fromName: params.fromName,
      to: params.to,
      cc: params.cc,
      subject: params.subject,
      text: params.text,
      html: params.html,
      replyTo: params.replyTo,
      inReplyTo: params.inReplyTo,
      references: params.references,
      attachments: params.attachments?.map((item) => ({
        filename: item.filename,
        contentType: item.contentType,
        content: item.content,
      })),
    });

    const accountId = await this.requireAccountId();
    const path = `/accounts/${accountId}/email/sending/send_raw`;
    const data = await this.sendWithRetry<{
      message_id: string;
      delivered: string[];
      permanent_bounces: string[];
      queued: string[];
    }>(path, {
      method: "POST",
      body: JSON.stringify({
        from: fromAddress,
        recipients,
        mime_message: mimeMessage,
      }),
    });
    return this.mapSendResult(data);
  }

  async sendEmail(params: {
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
  }): Promise<CfEmailSendResult> {
    const fromName = params.fromName?.trim();
    const needsRaw = Boolean(
      fromName ||
        params.inReplyTo?.trim() ||
        params.references?.trim() ||
        (params.rawAttachments?.length ?? 0) > 0,
    );
    if (needsRaw) {
      return this.sendRawEmail({
        ...params,
        fromName,
        attachments: params.rawAttachments,
      });
    }
    if (params.attachments?.length) {
      return this.sendStructuredEmail({
        ...params,
        attachments: params.attachments,
      });
    }
    return this.sendStructuredEmail(params);
  }

  async listZones(): Promise<CfListedZone[]> {
    const pinned = this.accountId;
    if (!pinned) return [];
    const zones: CfListedZone[] = [];
    let page = 1;
    for (;;) {
      const data = await this.request<
        Array<{
          id?: string;
          name?: string;
          status?: string;
          account?: { id?: string };
        }>
      >(`/zones?${zonesListQuery(page, pinned)}`);
      const batch = data.result ?? [];
      if (batch.length === 0) break;
      for (const zone of batch) {
        zones.push(mapCfZoneRow(zone));
      }
      if (batch.length < 50) break;
      page += 1;
    }
    return zonesOnPinnedAccount(zones, pinned);
  }

  async resolveZoneId(domain: string): Promise<string | null> {
    if (!this.accountId) return null;
    const name = domain.trim();
    const params = new URLSearchParams({ name });
    params.set("account.id", this.accountId);
    const data = await this.request<
      Array<{ id: string; name: string; account?: { id?: string } }>
    >(`/zones?${params.toString()}`);
    const want = name.toLowerCase();
    const zone = data.result?.find((item) => {
      if (item.name.toLowerCase() !== want) return false;
      return zoneBelongsToPinnedAccount(item.account?.id, this.accountId);
    });
    return zone?.id ?? null;
  }

  async listDnsRecords(
    zoneId: string,
    opts: { type?: string; name?: string } = {},
  ): Promise<CfDnsRecord[]> {
    const params = new URLSearchParams();
    if (opts.type) params.set("type", opts.type);
    if (opts.name) params.set("name", opts.name);
    const query = params.toString() ? `?${params.toString()}` : "";
    const data = await this.request<CfDnsRecord[]>(
      `/zones/${zoneId}/dns_records${query}`,
    );
    return data.result ?? [];
  }

  async createDnsRecord(
    zoneId: string,
    record: {
      type: string;
      name: string;
      content: string;
      proxied?: boolean;
      priority?: number;
      ttl?: number;
    },
  ): Promise<CfDnsRecord> {
    const data = await this.request<CfDnsRecord>(
      `/zones/${zoneId}/dns_records`,
      {
        method: "POST",
        body: JSON.stringify({
          type: record.type,
          name: record.name,
          content: record.content,
          proxied: record.proxied ?? false,
          priority: record.priority,
          ttl: record.ttl ?? 1,
        }),
      },
    );
    return data.result;
  }

  async updateDnsRecord(
    zoneId: string,
    recordId: string,
    record: {
      type: string;
      name: string;
      content: string;
      proxied?: boolean;
      priority?: number;
      ttl?: number;
    },
  ): Promise<CfDnsRecord> {
    const data = await this.request<CfDnsRecord>(
      `/zones/${zoneId}/dns_records/${recordId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          type: record.type,
          name: record.name,
          content: record.content,
          proxied: record.proxied ?? false,
          priority: record.priority,
          ttl: record.ttl ?? 1,
        }),
      },
    );
    return data.result;
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request<null>(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: "DELETE",
    });
  }

  /** Match by type + normalized name; update if found, else create. */
  async upsertDnsRecord(
    zoneId: string,
    record: {
      type: string;
      name: string;
      content: string;
      proxied?: boolean;
      priority?: number;
      ttl?: number;
    },
  ): Promise<CfDnsRecord> {
    const records = await this.listDnsRecords(zoneId, { type: record.type });
    const targetName = record.name.toLowerCase();
    const existing = records.find(
      (r) => r.type === record.type && r.name.toLowerCase() === targetName,
    );
    if (existing) {
      return this.updateDnsRecord(zoneId, existing.id, record);
    }
    return this.createDnsRecord(zoneId, record);
  }

  async getEmailRoutingSettings(zoneId: string): Promise<CfEmailRoutingSettings> {
    const data = await this.request<{ enabled: boolean }>(
      `/zones/${zoneId}/email/routing`,
    );
    return { enabled: Boolean(data.result?.enabled) };
  }

  async enableEmailRouting(zoneId: string): Promise<CfEmailRoutingSettings> {
    const data = await this.request<{ enabled: boolean }>(
      `/zones/${zoneId}/email/routing/enable`,
      { method: "POST" },
    );
    return { enabled: Boolean(data.result?.enabled) };
  }

  async listEmailRoutingRules(zoneId: string): Promise<CfEmailRoutingRule[]> {
    const data = await this.request<CfEmailRoutingRule[]>(
      `/zones/${zoneId}/email/routing/rules`,
    );
    return data.result ?? [];
  }

  async createEmailRoutingRule(
    zoneId: string,
    rule: {
      name?: string;
      enabled?: boolean;
      priority?: number;
      actions: CfEmailRoutingAction[];
      matchers: CfEmailRoutingMatcher[];
    },
  ): Promise<CfEmailRoutingRule> {
    const data = await this.request<CfEmailRoutingRule>(
      `/zones/${zoneId}/email/routing/rules`,
      {
        method: "POST",
        body: JSON.stringify(rule),
      },
    );
    return data.result;
  }

  async updateEmailRoutingRule(
    zoneId: string,
    ruleId: string,
    rule: {
      name?: string;
      enabled?: boolean;
      priority?: number;
      actions?: CfEmailRoutingAction[];
      matchers?: CfEmailRoutingMatcher[];
    },
  ): Promise<CfEmailRoutingRule> {
    const data = await this.request<CfEmailRoutingRule>(
      `/zones/${zoneId}/email/routing/rules/${ruleId}`,
      {
        method: "PUT",
        body: JSON.stringify(rule),
      },
    );
    return data.result;
  }

  async deleteEmailRoutingRule(zoneId: string, ruleId: string): Promise<void> {
    await this.request<null>(
      `/zones/${zoneId}/email/routing/rules/${ruleId}`,
      { method: "DELETE" },
    );
  }

  async listSendingSubdomains(zoneId: string): Promise<CfSendingSubdomain[]> {
    const data = await this.request<CfSendingSubdomain[]>(
      `/zones/${zoneId}/email/sending/subdomains`,
    );
    return data.result ?? [];
  }

  /**
   * Onboard or create an Email Sending domain. Official docs only describe
   * the dashboard flow; this POST is the documented-adjacent list sibling.
   * Callers must treat 404/405 as "API not available — use the dashboard".
   */
  async createSendingSubdomain(
    zoneId: string,
    name: string,
  ): Promise<CfSendingSubdomain> {
    const path = `/zones/${zoneId}/email/sending/subdomains`;
    const { res, data } = await this.requestOnce<CfSendingSubdomain>(path, {
      method: "POST",
      body: JSON.stringify({ name, enabled: true }),
    });
    if (res.status === 404 || res.status === 405) {
      throw new SendingOnboardApiMissingError(res.status);
    }
    if (res.ok && data.success) return data.result;
    throw this.formatCfError(res, data, path, "POST");
  }

  async updateSendingSubdomain(
    zoneId: string,
    name: string,
    patch: { enabled: boolean },
  ): Promise<CfSendingSubdomain> {
    const path = `/zones/${zoneId}/email/sending/subdomains`;
    const { res, data } = await this.requestOnce<CfSendingSubdomain>(path, {
      method: "PATCH",
      body: JSON.stringify({ name, enabled: patch.enabled }),
    });
    if (res.status === 404 || res.status === 405) {
      throw new SendingOnboardApiMissingError(res.status);
    }
    if (res.ok && data.success) return data.result;
    throw this.formatCfError(res, data, path, "PATCH");
  }

  /** Email Sending bounce MX on `cf-bounce.{domain}` — apex onboard signal. */
  async hasSendingBounceMx(zoneId: string, domain: string): Promise<boolean> {
    const name = `cf-bounce.${domain.trim().toLowerCase()}`;
    const records = await this.listDnsRecords(zoneId, { type: "MX", name });
    return records.some((record) => record.type === "MX");
  }
}

export class SendingOnboardApiMissingError extends Error {
  status: number;

  constructor(status: number) {
    super(
      `Cloudflare Email Sending onboard API is not available (HTTP ${status}). Open Cloudflare → Email Service → Email Sending → Onboard Domain, then Recheck.`,
    );
    this.name = "SendingOnboardApiMissingError";
    this.status = status;
  }
}
