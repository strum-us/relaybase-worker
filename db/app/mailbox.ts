import { asc, eq } from "drizzle-orm";
import type { AppDb } from "./index";
import { addresses, domains, type AddressRow, type DomainRow } from "./schema";
import type { MailboxAddress, MailboxData } from "../../src/lib/catalog-store";

function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/\.$/, "");
}

function rowToAddress(row: AddressRow): MailboxAddress {
  return {
    email: row.email,
    domain: row.domain,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.signature ? { signature: row.signature } : {}),
    ...(row.inboundEnabled === 0 ? { inboundEnabled: false } : {}),
    ...(row.mobileEnabled === 0 ? { mobileEnabled: false } : {}),
  };
}

export async function readMailbox(db: AppDb): Promise<MailboxData> {
  if (!db) return { domains: [], addresses: [] };
  const [domainRows, addressRows] = await Promise.all([
    db.select().from(domains).orderBy(asc(domains.domain)).all(),
    db.select().from(addresses).all(),
  ]);
  return {
    domains: domainRows.map((r) => r.domain),
    addresses: addressRows.map(rowToAddress),
  };
}

export async function addDomain(db: AppDb, domainInput: string): Promise<void> {
  if (!db) return;
  const domain = normalizeDomain(domainInput);
  if (!domain || domain === "example.com") {
    throw new Error("A valid domain is required");
  }
  await db
    .insert(domains)
    .values({ id: domain, domain, createdAt: new Date().toISOString() })
    .onConflictDoNothing()
    .run();
}

export async function removeDomain(db: AppDb, domainInput: string): Promise<void> {
  if (!db) return;
  const domain = normalizeDomain(domainInput);
  await db.delete(domains).where(eq(domains.id, domain)).run();
}

export async function upsertAddresses(
  db: AppDb,
  domainInput: string,
  entries: Array<{
    email: string;
    displayName?: string;
    inboundEnabled?: boolean;
    mobileEnabled?: boolean;
  }>,
): Promise<{ added: MailboxAddress[] }> {
  if (!db) return { added: [] };
  const domain = normalizeDomain(domainInput);
  await addDomain(db, domain);
  const added: MailboxAddress[] = [];
  for (const entry of entries) {
    const email = entry.email.trim().toLowerCase();
    if (!email.endsWith(`@${domain}`)) continue;
    const values = {
      id: email,
      email,
      domain,
      ...(entry.displayName?.trim() ? { displayName: entry.displayName.trim() } : {}),
      inboundEnabled: entry.inboundEnabled === false ? 0 : 1,
      mobileEnabled: entry.mobileEnabled === false ? 0 : 1,
      createdAt: new Date().toISOString(),
    };
    await db
      .insert(addresses)
      .values(values)
      .onConflictDoUpdate({
        target: addresses.email,
        set: {
          displayName: values.displayName ?? null,
          inboundEnabled: values.inboundEnabled,
          mobileEnabled: values.mobileEnabled,
        },
      })
      .run();
    added.push({
      email,
      domain,
      ...(values.displayName ? { displayName: values.displayName } : {}),
      ...(entry.inboundEnabled === false ? { inboundEnabled: false } : {}),
      ...(entry.mobileEnabled === false ? { mobileEnabled: false } : {}),
    });
  }
  return { added };
}

export async function removeAddress(
  db: AppDb,
  emailInput: string,
): Promise<MailboxAddress | null> {
  if (!db) return null;
  const email = emailInput.trim().toLowerCase();
  const row = await db.select().from(addresses).where(eq(addresses.email, email)).get();
  if (!row) return null;
  await db.delete(addresses).where(eq(addresses.email, email)).run();
  return rowToAddress(row);
}

export async function updateAddressProfile(
  db: AppDb,
  emailInput: string,
  patch: { displayName?: string; signature?: string },
): Promise<MailboxAddress | null> {
  if (!db) return null;
  const email = emailInput.trim().toLowerCase();
  const row = await db.select().from(addresses).where(eq(addresses.email, email)).get();
  if (!row) return null;
  const displayName =
    patch.displayName !== undefined ? patch.displayName.trim() : (row.displayName ?? "");
  const signature =
    patch.signature !== undefined ? patch.signature : (row.signature ?? "");
  await db
    .update(addresses)
    .set({
      displayName: displayName || null,
      signature: signature || null,
    })
    .where(eq(addresses.email, email))
    .run();
  return {
    email: row.email,
    domain: row.domain,
    ...(displayName ? { displayName } : {}),
    ...(signature ? { signature } : {}),
    ...(row.inboundEnabled === 0 ? { inboundEnabled: false } : {}),
    ...(row.mobileEnabled === 0 ? { mobileEnabled: false } : {}),
  };
}

export async function getAddress(
  db: AppDb,
  email: string,
): Promise<MailboxAddress | null> {
  if (!db) return null;
  const row = await db
    .select()
    .from(addresses)
    .where(eq(addresses.email, email.trim().toLowerCase()))
    .get();
  return row ? rowToAddress(row) : null;
}

/**
 * Replace the entire mailbox (domains + addresses) in one transaction.
 * Used by PUT /console/mailbox — the admin "replace all" endpoint.
 */
export async function replaceMailbox(
  db: AppDb,
  data: { domains: string[]; addresses: MailboxAddress[] },
): Promise<void> {
  if (!db) return;
  // D1 doesn't support multi-statement transactions from drizzle yet, so
  // we delete then re-insert. Order matters: addresses first (FK), then domains.
  await db.delete(addresses).run();
  await db.delete(domains).run();
  const now = new Date().toISOString();
  for (const domain of data.domains) {
    await db
      .insert(domains)
      .values({ id: domain, domain, createdAt: now })
      .onConflictDoNothing()
      .run();
  }
  for (const addr of data.addresses) {
    const email = addr.email.trim().toLowerCase();
    await db
      .insert(addresses)
      .values({
        id: email,
        email,
        domain: addr.domain,
        ...(addr.displayName ? { displayName: addr.displayName } : {}),
        ...(addr.signature ? { signature: addr.signature } : {}),
        inboundEnabled: addr.inboundEnabled === false ? 0 : 1,
        mobileEnabled: addr.mobileEnabled === false ? 0 : 1,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: addresses.email,
        set: {
          domain: addr.domain,
          displayName: addr.displayName ?? null,
          signature: addr.signature ?? null,
          inboundEnabled: addr.inboundEnabled === false ? 0 : 1,
          mobileEnabled: addr.mobileEnabled === false ? 0 : 1,
        },
      })
      .run();
  }
}

/**
 * Full-field update for a single address (displayName, signature,
 * inboundEnabled, mobileEnabled). Used by PATCH /console/addresses.
 */
export async function updateAddress(
  db: AppDb,
  emailInput: string,
  patch: {
    displayName?: string | null;
    signature?: string | null;
    inboundEnabled?: boolean;
    mobileEnabled?: boolean;
  },
): Promise<MailboxAddress | null> {
  if (!db) return null;
  const email = emailInput.trim().toLowerCase();
  const row = await db.select().from(addresses).where(eq(addresses.email, email)).get();
  if (!row) return null;
  const updates: Partial<AddressRow> = {};
  if (patch.displayName !== undefined) {
    updates.displayName =
      patch.displayName === null || !patch.displayName.trim()
        ? null
        : patch.displayName.trim();
  }
  if (patch.signature !== undefined) {
    updates.signature =
      patch.signature === null || !patch.signature
        ? null
        : patch.signature;
  }
  if (patch.inboundEnabled !== undefined) {
    updates.inboundEnabled = patch.inboundEnabled ? 1 : 0;
  }
  if (patch.mobileEnabled !== undefined) {
    updates.mobileEnabled = patch.mobileEnabled ? 1 : 0;
  }
  await db.update(addresses).set(updates).where(eq(addresses.email, email)).run();
  const updated = await db.select().from(addresses).where(eq(addresses.email, email)).get();
  return updated ? rowToAddress(updated) : null;
}
