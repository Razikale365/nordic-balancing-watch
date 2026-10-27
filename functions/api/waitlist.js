// Cloudflare Pages Function: POST /api/waitlist — stores an email + optional role in D1.
const ROLES = new Set(["trader", "brp", "bess", "analyst", "researcher", "other"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A signup is under 400 bytes; anything much larger is not from the form.
const MAX_BODY = 2048;
// Function responses do not get the headers in site/_headers.
const SECURITY = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cache-control": "no-store"
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...SECURITY }
  });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ ok: false, error: "forbidden origin" }, 403);
  }

  // Only JSON: a cross-site page cannot send it without a CORS preflight, which is refused.
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return json({ ok: false, error: "expected JSON" }, 415);
  }
  if (Number(request.headers.get("content-length")) > MAX_BODY) {
    return json({ ok: false, error: "request too large" }, 413);
  }

  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) {
      return json({ ok: false, error: "request too large" }, 413);
    }
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  // Honeypot: pretend it worked, store nothing.
  if (body.website) {
    return json({ ok: true }, 200);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return json({ ok: false, error: "invalid email" }, 400);
  }

  const role = body.role == null ? "" : String(body.role);
  if (role !== "" && !ROLES.has(role)) {
    return json({ ok: false, error: "invalid role" }, 400);
  }

  if (!env || !env.DB) {
    return json({ ok: false, error: "service unavailable" }, 503);
  }

  const createdAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  try {
    await env.DB.prepare(
      "INSERT INTO waitlist (email, role, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(email) DO NOTHING"
    ).bind(email, role || null, createdAt).run();
  } catch {
    return json({ ok: false, error: "service unavailable" }, 503);
  }

  return json({ ok: true }, 200);
}

export function onRequest() {
  return json({ ok: false, error: "method not allowed" }, 405);
}
