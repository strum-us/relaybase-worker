# Experiment: Subdomain onboarding (worker)

**Status:** Parked on `feat/subdomain-onboarding`. See also `relaybase-main/docs/experiments/subdomain-onboarding.md` for full write-up (UI, UX, CF investigation).

## Worker changes on this branch

- `src/lib/zone-resolution.ts` — `resolveZoneForDomain()` parent zone walk-up
- `src/lib/subdomain-onboard.ts` — `onboardSubdomain()` (sending API + routing DNS)
- `src/routes/console/subdomain-onboard.ts` — `POST /console/subdomain-onboard`
- `src/routes/console/domains.ts` — `subdomain_candidate` response
- `src/lib/sending-onboard.ts` — parent zone fallback
- `src/app.ts` — route registration

## API

`POST /console/subdomain-onboard`

Body: `{ domain, confirmReplace?, accountId? }`

Returns sending health + `routing` block (`ready` | `dkim_pending` | `dashboard_required`).

## Blocker (summary)

Email Routing subdomain registration requires the **apex zone** to be onboarded to Email Routing first. Apex with Google Workspace MX cannot onboard without replacing/locking apex MX. No REST API exists to add a routing subdomain directly.

Sending subdomain onboarding via `createSendingSubdomain` **does** work independently.

## Dogfood deploy

Branch was tested with worker version **0.1.2** deployed to `relaybase-api` (not merged to `staging`).
