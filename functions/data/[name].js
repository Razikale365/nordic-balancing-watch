// Cloudflare Pages Function: GET /data/<file> — serves the collector's hourly files from the
// `data` branch, so new data needs no redeploy. Cached at the edge for five minutes.
const FILES = new Set(["summary.json", "revisions.json"]);
const TTL = 300;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

export async function onRequestGet({ request, env, params }) {
  const name = String(params.name || "");
  if (!FILES.has(name)) {
    return json({ ok: false, error: "not found" }, 404);
  }
  // Without a data source (local dev), serve the static file from site/data.
  if (!env || !env.DATA_BASE_URL) {
    return env.ASSETS.fetch(request);
  }

  const upstream = await fetch(`${env.DATA_BASE_URL.replace(/\/$/, "")}/${name}`, {
    cf: { cacheTtl: TTL, cacheEverything: true }
  });
  if (!upstream.ok) {
    return json({ ok: false, error: "data unavailable" }, 502);
  }
  const text = await upstream.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "data unavailable" }, 502);
  }
  if (!body || body.schema !== 1) {
    return json({ ok: false, error: "data unavailable" }, 502);
  }
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${TTL}` }
  });
}

export function onRequest() {
  return json({ ok: false, error: "method not allowed" }, 405);
}
