import type { MxConflictRecord } from "./inbound-routing";
import type { MailboxDomainSummary } from "./catalog-store";

export type DomainOnboardingStep = {
  id: string;
  label: string;
  status: string;
  errorCode?: string;
  error?: string;
};

export type DomainOnboardingState = {
  status: "ready" | "failed" | "in_progress";
  currentStep: string | null;
  currentStepLabel: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  zoneId: string | null;
  sendingSubdomainId: string | null;
  mxConflicts: MxConflictRecord[];
  steps: DomainOnboardingStep[];
};

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
