/** Time buckets for dashboard / account stats series. */

export type StatsRange = "24h" | "7d" | "30d";

export type StatsBucket = {
  label: string;
  at: string;
  value: number;
};

export const RANGE_MS: Record<StatsRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const RANGE_BUCKETS: Record<StatsRange, number> = {
  "24h": 24,
  "7d": 7,
  "30d": 30,
};

export function parseStatsRange(value: string | null | undefined): StatsRange {
  if (value === "24h" || value === "7d" || value === "30d") return value;
  return "7d";
}

function bucketLabel(date: Date, range: StatsRange): string {
  if (range === "24h") {
    return date.toLocaleTimeString("en-US", { hour: "numeric" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function createBuckets(
  range: StatsRange,
  now = Date.now(),
): StatsBucket[] {
  const count = RANGE_BUCKETS[range];
  const span = RANGE_MS[range];
  const bucketMs = span / count;
  const start = now - span;

  return Array.from({ length: count }, (_, index) => {
    const at = start + index * bucketMs;
    return {
      label: bucketLabel(new Date(at + bucketMs / 2), range),
      at: new Date(at).toISOString(),
      value: 0,
    };
  });
}

export function bucketIndex(
  timestamp: number,
  range: StatsRange,
  now = Date.now(),
): number | null {
  const span = RANGE_MS[range];
  const count = RANGE_BUCKETS[range];
  const start = now - span;
  if (timestamp < start || timestamp > now) return null;
  const bucketMs = span / count;
  return Math.min(count - 1, Math.floor((timestamp - start) / bucketMs));
}

export function incrementBucket(
  buckets: StatsBucket[],
  index: number | null,
): void {
  if (index === null || index < 0 || index >= buckets.length) return;
  buckets[index].value += 1;
}
