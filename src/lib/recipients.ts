const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function splitRecipientInput(input: string): string[] {
  return input
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function normalizeRecipients(
  value: string | string[] | undefined,
): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const entry of raw) {
    for (const part of splitRecipientInput(entry)) {
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      emails.push(part);
    }
  }
  return emails;
}

export function findInvalidRecipients(emails: string[]): string[] {
  return emails.filter((email) => !EMAIL_RE.test(email));
}
