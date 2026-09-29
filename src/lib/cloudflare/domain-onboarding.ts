import type { MxConflictRecord } from "./inbound-routing";
import type { MailboxDomainSummary } from "../catalog/catalog-store";

export type DomainOnboardingStep = {
  id: string;
  label: string;
  status: string;
  errorCode?: string;
  error?: string;
};

export type DomainOnboardingState = {
  status: "ready" | "failed" | "in_progress" | "waiting" | "running" | "idle";
  currentStep: string | null;
  currentStepLabel: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  zoneId: string | null;
  sendingSubdomainId: string | null;
  mxConflicts: MxConflictRecord[];
  steps: DomainOnboardingStep[];
  /** Cloudflare-assigned nameservers (when zone exists but is not active yet). */
  nameServers?: string[];
  cfZoneStatus?: string | null;
};

export function createReadyOnboarding(
  zoneId: string | null,
  nameServers: string[] = [],
  cfZoneStatus = "active",
): DomainOnboardingState {
  return {
    status: "ready",
    currentStep: null,
    currentStepLabel: null,
    lastError: null,
    lastErrorCode: null,
    zoneId,
    sendingSubdomainId: null,
    mxConflicts: [],
    steps: [],
    nameServers,
    cfZoneStatus,
  };
}

export function createZonePendingOnboarding(
  domain: string,
  zoneId: string,
  nameServers: string[],
  cfZoneStatus: string,
): DomainOnboardingState {
  return {
    status: "waiting",
    currentStep: "nameservers",
    currentStepLabel: "Update nameservers at your domain registrar",
    lastError: `Cloudflare zone for ${domain} is ${cfZoneStatus}. Point your registrar to the nameservers below.`,
    lastErrorCode: "ZONE_PENDING",
    zoneId,
    sendingSubdomainId: null,
    mxConflicts: [],
    steps: [
      {
        id: "nameservers",
        label: "Update nameservers",
        status: "waiting",
        errorCode: "ZONE_PENDING",
      },
    ],
    nameServers,
    cfZoneStatus,
  };
}

export function createZoneNotFoundOnboarding(domain: string): DomainOnboardingState {
  return {
    status: "waiting",
    currentStep: "add_zone",
    currentStepLabel: "Add this domain to Cloudflare",
    lastError: `${domain} is not on your Cloudflare account yet. Add it in Cloudflare, then refresh.`,
    lastErrorCode: "ZONE_NOT_FOUND",
    zoneId: null,
    sendingSubdomainId: null,
    mxConflicts: [],
    steps: [
      {
        id: "add_zone",
        label: "Add domain to Cloudflare",
        status: "waiting",
        errorCode: "ZONE_NOT_FOUND",
      },
    ],
    nameServers: [],
    cfZoneStatus: null,
  };
}

export function createMxConflictOnboarding(
  domain: string,
  zoneId: string | null,
  mxConflicts: MxConflictRecord[],
): DomainOnboardingState {
  return {
    status: "failed",
    currentStep: "routing_enable",
    currentStepLabel: "Enable Email Routing",
    lastError: `Non-Cloudflare MX records exist for ${domain}. Remove them to enable Email Routing.`,
    lastErrorCode: "MX_CONFLICT",
    zoneId,
    sendingSubdomainId: null,
    mxConflicts,
    steps: [
      {
        id: "routing_enable",
        label: "Enable Email Routing",
        status: "failed",
        errorCode: "MX_CONFLICT",
        error: `Non-Cloudflare MX records exist for ${domain}.`,
      },
    ],
  };
}

export function createMxConflictErrorPayload(
  domain: string,
  zoneId: string | null,
  mxConflicts: MxConflictRecord[],
  summaries: MailboxDomainSummary[],
) {
  const targetSummary = summaries.find((d) => d.domain === domain);
  const onboarding = createMxConflictOnboarding(domain, zoneId, mxConflicts);
  if (targetSummary) {
    targetSummary.onboarding = onboarding as never;
  }
  return {
    error: `Non-Cloudflare MX records exist for ${domain}. Remove them to enable Email Routing.`,
    mxConflict: true,
    domain,
    mxConflicts,
    domains: summaries,
    onboarding,
  };
}
