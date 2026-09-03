import { normalizeCfAccountId } from "./cf-account-id.ts";

export type CfListedZone = {
  id: string;
  name: string;
  status: string;
  accountId: string;
};

export function mapCfZoneRow(zone: {
  id?: string;
  name?: string;
  status?: string;
  account?: { id?: string };
}): CfListedZone {
  return {
    id: zone.id ?? "",
    name: zone.name ?? "",
    status: zone.status ?? "",
    accountId: normalizeCfAccountId(zone.account?.id) ?? "",
  };
}

/**
 * Keep zones on the pinned CF account only. No pin → empty.
 * A user API token can see every account the user belongs to; import and
 * sending health must never use that unscoped list.
 */
export function zonesOnPinnedAccount<T extends { accountId?: string }>(
  zones: T[],
  pinnedAccountId: string | null | undefined,
): T[] {
  const pinned = normalizeCfAccountId(pinnedAccountId);
  if (!pinned) return [];
  return zones.filter(
    (zone) => normalizeCfAccountId(zone.accountId) === pinned,
  );
}

export function zoneBelongsToPinnedAccount(
  zoneAccountId: string | null | undefined,
  pinnedAccountId: string | null | undefined,
): boolean {
  const pinned = normalizeCfAccountId(pinnedAccountId);
  if (!pinned) return false;
  return normalizeCfAccountId(zoneAccountId) === pinned;
}

export function zonesListQuery(
  page: number,
  pinnedAccountId: string,
): string {
  const pinned = normalizeCfAccountId(pinnedAccountId);
  if (!pinned) {
    throw new Error("Cloudflare zone list requires a pinned account id");
  }
  const params = new URLSearchParams({
    per_page: "50",
    page: String(page),
    "account.id": pinned,
  });
  return params.toString();
}
