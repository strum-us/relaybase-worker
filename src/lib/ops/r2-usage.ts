export type InboundR2Usage = {
  objectCount: number;
  totalBytes: number;
  /** True when the scan stopped early (bucket larger than the page budget). */
  truncated: boolean;
};

/** Cap Class A list cost / Worker time — 20 pages × 1000 keys. */
const MAX_LIST_PAGES = 20;

/**
 * Sum object sizes in the mailbox R2 bucket via binding list.
 * Returns null when the binding is missing or list fails.
 */
export async function measureInboundR2Usage(
  bucket: R2Bucket | undefined,
): Promise<InboundR2Usage | null> {
  if (!bucket) return null;
  try {
    let objectCount = 0;
    let totalBytes = 0;
    let cursor: string | undefined;
    let truncated = false;

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const listed = await bucket.list({ limit: 1000, cursor });
      for (const object of listed.objects) {
        objectCount += 1;
        totalBytes += object.size;
      }
      if (!listed.truncated) {
        truncated = false;
        break;
      }
      cursor = listed.cursor;
      if (page === MAX_LIST_PAGES - 1) truncated = true;
    }

    return { objectCount, totalBytes, truncated };
  } catch (error) {
    console.error("Mailbox R2 usage failed", error);
    return null;
  }
}
