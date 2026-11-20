/**
 * The Cloudflare Workers API calls a Relaybase Worker needs to redeploy itself.
 * Same calls as the app's install pipeline (app/src/services/cloudflare/client.ts).
 */

export class CfApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

type Envelope<T> = { success?: boolean; errors?: { code?: number; message?: string }[]; result: T };

const API = "https://api.cloudflare.com/client/v4";

async function readEnvelope<T>(res: Response, fallback: string): Promise<Envelope<T>> {
  const text = await res.text();
  let json: Envelope<T>;
  try {
    json = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new CfApiError(text.slice(0, 300) || `${fallback} (${res.status})`, res.status);
  }
  if (!json.success) {
    const first = json.errors?.[0];
    throw new CfApiError(first?.message || `${fallback} (${res.status})`, res.status, first?.code);
  }
  return json;
}

async function cf<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  return (await readEnvelope<T>(res, "Cloudflare API")).result;
}

export type ScriptBinding = { type: string; name: string; [key: string]: unknown };

export type ScriptSettings = {
  bindings?: ScriptBinding[];
  compatibility_date?: string;
  compatibility_flags?: string[];
  limits?: { cpu_ms?: number } | null;
  placement?: Record<string, unknown> | null;
  logpush?: boolean;
  observability?: Record<string, unknown> | null;
  tail_consumers?: { service: string; environment?: string; namespace?: string }[] | null;
};

/** Current bindings and settings of the deployed script. Secret bindings carry names only. */
export async function scriptSettings(token: string, accountId: string, scriptName: string): Promise<ScriptSettings> {
  return cf<ScriptSettings>(token, "GET", `/accounts/${accountId}/workers/scripts/${scriptName}/settings`);
}

export async function putScript(
  token: string,
  accountId: string,
  scriptName: string,
  metadata: Record<string, unknown>,
  mainModule: string,
  source: Uint8Array,
): Promise<void> {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(mainModule, new Blob([source], { type: "application/javascript+module" }), mainModule);
  const res = await fetch(`${API}/accounts/${accountId}/workers/scripts/${scriptName}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  await readEnvelope<unknown>(res, "Worker upload failed");
}

export async function listSecretNames(token: string, accountId: string, scriptName: string): Promise<string[]> {
  const rows = await cf<{ name: string }[]>(token, "GET", `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`);
  return (rows ?? []).map((row) => row.name);
}

export async function putSecret(
  token: string,
  accountId: string,
  scriptName: string,
  name: string,
  text: string,
): Promise<void> {
  await cf(token, "PUT", `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`, {
    name,
    text,
    type: "secret_text",
  });
}

/** Cron expressions of the script's Cron Triggers. They live beside the script and survive uploads. */
export async function scriptSchedules(token: string, accountId: string, scriptName: string): Promise<string[]> {
  const result = await cf<{ schedules?: { cron: string }[] }>(
    token,
    "GET",
    `/accounts/${accountId}/workers/scripts/${scriptName}/schedules`,
  );
  return (result?.schedules ?? []).map((entry) => entry.cron);
}

/** Replaces every Cron Trigger of the script. */
export async function putSchedules(token: string, accountId: string, scriptName: string, crons: string[]): Promise<void> {
  await cf(
    token,
    "PUT",
    `/accounts/${accountId}/workers/scripts/${scriptName}/schedules`,
    crons.map((cron) => ({ cron })),
  );
}
