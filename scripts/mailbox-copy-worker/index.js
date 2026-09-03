/**
 * One-shot R2→R2 copy Worker. Bound to SRC (relaybase-inbound) and DST
 * (relaybase-mailbox). Copies stay inside Cloudflare (no laptop download).
 *
 * Auth: MIGRATE_SECRET (wrangler secret). Query `?secret=` or header
 * `x-migrate-secret`. Paginate with `?cursor=`.
 */
const BATCH = 80;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const secret =
      url.searchParams.get("secret") ||
      request.headers.get("x-migrate-secret") ||
      "";
    if (!env.MIGRATE_SECRET || secret !== env.MIGRATE_SECRET) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    if (url.pathname === "/status") {
      const [src, dst] = await Promise.all([countAll(env.SRC), countAll(env.DST)]);
      return Response.json({ src, dst });
    }

    const cursor = url.searchParams.get("cursor") || undefined;
    const listed = await env.SRC.list({ limit: BATCH, cursor });
    let copied = 0;
    for (const obj of listed.objects) {
      const src = await env.SRC.get(obj.key);
      if (!src) continue;
      await env.DST.put(obj.key, src.body, {
        httpMetadata: src.httpMetadata,
        customMetadata: src.customMetadata,
      });
      copied += 1;
    }

    return Response.json({
      copied,
      listed: listed.objects.length,
      done: !listed.truncated,
      cursor: listed.truncated ? listed.cursor : null,
    });
  },
};

async function countAll(bucket) {
  let n = 0;
  let cursor;
  do {
    const listed = await bucket.list({ limit: 1000, cursor });
    n += listed.objects.length;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return n;
}
