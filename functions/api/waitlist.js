// Cloudflare Pages Function for the waitlist in D1.
// POST stores an email + optional role and returns a private removal token; only a SHA-256 hash
// of the token is stored. DELETE with that token removes the address.
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

// Real interest arrives a few sign-ups at a time; a script filling the table does not. Counted
// from the rows themselves, so no address or IP is kept for it.
const MAX_PER_HOUR = 30;

// 32 random bytes, base64url without padding.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...SECURITY }
  });
}

// Same-origin JSON object of at most MAX_BODY bytes: { body } or { error: Response }.
async function readBody(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return { error: json({ ok: false, error: "forbidden origin" }, 403) };
  }

  // Only JSON: a cross-site page cannot send it without a CORS preflight, which is refused.
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return { error: json({ ok: false, error: "expected JSON" }, 415) };
  }
  if (Number(request.headers.get("content-length")) > MAX_BODY) {
    return { error: json({ ok: false, error: "request too large" }, 413) };
  }

  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) {
      return { error: json({ ok: false, error: "request too large" }, 413) };
    }
    body = JSON.parse(text);
  } catch {
    return { error: json({ ok: false, error: "invalid JSON body" }, 400) };
  }
  if (!body || typeof body !== "object") {
    return { error: json({ ok: false, error: "invalid JSON body" }, 400) };
  }
  return { body };
}

export async function onRequestPost({ request, env }) {
  const { body, error } = await readBody(request);
  if (error) return error;

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
  // A token is returned on every successful request, so the answer does not tell whether the
  // address was already listed. For an address already listed it is not stored (the earlier
  // link still works); otherwise anyone who knows an address could obtain a link to remove it.
  const removeToken = newToken();
  try {
    const since = new Date(Date.now() - 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE created_at >= ?1")
      .bind(since).first();
    if (recent && recent.n >= MAX_PER_HOUR) {
      return json({ ok: false, error: "too many sign-ups in the last hour; please try again later" }, 429);
    }
    await env.DB.prepare(
      "INSERT INTO waitlist (email, role, created_at, remove_hash) VALUES (?1, ?2, ?3, ?4)" +
        " ON CONFLICT(email) DO NOTHING"
    ).bind(email, role || null, createdAt, await hashToken(removeToken)).run();
  } catch {
    return json({ ok: false, error: "service unavailable" }, 503);
  }

  return json({ ok: true, removeToken }, 200);
}

export async function onRequestDelete({ request, env }) {
  const { body, error } = await readBody(request);
  if (error) return error;

  const token = typeof body.token === "string" ? body.token : "";
  if (!TOKEN_RE.test(token)) {
    return json({ ok: false, error: "invalid removal link" }, 400);
  }
  if (!env || !env.DB) {
    return json({ ok: false, error: "service unavailable" }, 503);
  }

  let result;
  try {
    result = await env.DB.prepare("DELETE FROM waitlist WHERE remove_hash = ?1")
      .bind(await hashToken(token)).run();
  } catch {
    return json({ ok: false, error: "service unavailable" }, 503);
  }

  // removed: false when the link was already used or never matched an address.
  return json({ ok: true, removed: Boolean(result && result.meta && result.meta.changes) }, 200);
}

export function onRequest() {
  return json({ ok: false, error: "method not allowed" }, 405);
}
