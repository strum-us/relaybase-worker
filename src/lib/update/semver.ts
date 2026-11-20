/** Semver helpers (no imports, so tests load them directly). */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function isVersion(value: string): boolean {
  return VERSION_RE.test(value);
}

/** Semver order (prerelease sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const ma = VERSION_RE.exec(a);
  const mb = VERSION_RE.exec(b);
  if (!ma || !mb) return a.localeCompare(b);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  const pa = ma[4];
  const pb = mb[4];
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa.localeCompare(pb, undefined, { numeric: true });
}
