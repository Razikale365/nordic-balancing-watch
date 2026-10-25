// Cloudflare Pages Function: POST /api/waitlist — stores an email + optional role in D1.
const ROLES = new Set(["trader", "brp", "bess", "analyst", "researcher", "other"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ ok: false, error: "forbidden origin" }, 403);
  }

  let body;
  try {
    body = await request.json();
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
