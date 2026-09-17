/** Cloudflare account ids are 32-char hex. Ignore binding placeholders / garbage. */
export function normalizeCfAccountId(
  raw: string | null | undefined,
): string | null {
  const id = raw?.trim() ?? "";
  if (!/^[a-f0-9]{32}$/i.test(id)) return null;
  return id.toLowerCase();
}
