import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { onRequestPost, onRequestDelete, onRequest } from "../functions/api/waitlist.js";

const URL = "https://nbw.example.pages.dev/api/waitlist";

function fakeDb(calls, changes = 1) {
  return {
    prepare(sql) {
      const entry = { sql, args: null };
      calls.push(entry);
      return {
        bind(...args) {
          entry.args = args;
          return { run: async () => ({ success: true, meta: { changes } }) };
        }
      };
    }
  };
}

function post(body, headers = {}, method = "POST") {
  return new Request(URL, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const TOKEN = "A".repeat(43);

test("valid signup is stored lower-cased and returns ok", async () => {
  const calls = [];
  const res = await onRequestPost({
    request: post({ email: "  Trader@Example.COM ", role: "trader", website: "" }),
    env: { DB: fakeDb(calls) }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO waitlist/);
  assert.match(calls[0].sql, /ON CONFLICT\(email\) DO NOTHING/);
  assert.equal(calls[0].args[0], "trader@example.com");
  assert.equal(calls[0].args[1], "trader");
  // The removal token is returned, and only its hash is stored.
  assert.match(body.removeToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(calls[0].args[3], sha256(body.removeToken));
  assert.ok(!calls[0].args.includes(body.removeToken));
});

test("each signup gets a different removal token", async () => {
  const tokens = new Set();
  for (let i = 0; i < 20; i++) {
    const res = await onRequestPost({ request: post({ email: "a@b.co" }), env: { DB: fakeDb([]) } });
    tokens.add((await res.json()).removeToken);
  }
  assert.equal(tokens.size, 20);
});

test("an address already listed gets the same answer and its stored link is kept", async () => {
  // ON CONFLICT DO NOTHING: changes = 0, the earlier hash stays; the answer looks the same.
  const res = await onRequestPost({
    request: post({ email: "a@b.co" }),
    env: { DB: fakeDb([], 0) }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.removeToken, /^[A-Za-z0-9_-]{43}$/);
});

test("a removal link deletes the address it was issued for", async () => {
  const calls = [];
  const res = await onRequestDelete({
    request: post({ token: TOKEN }, {}, "DELETE"),
    env: { DB: fakeDb(calls, 1) }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, removed: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^DELETE FROM waitlist WHERE remove_hash = \?1$/);
  assert.deepEqual(calls[0].args, [sha256(TOKEN)]);
});

test("a used or unknown removal link removes nothing and says so", async () => {
  const res = await onRequestDelete({
    request: post({ token: TOKEN }, {}, "DELETE"),
    env: { DB: fakeDb([], 0) }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, removed: false });
});

test("a malformed removal token gets 400 and touches nothing", async () => {
  for (const token of ["", "short", "A".repeat(44), "A".repeat(42) + "=", 12345, null]) {
    const calls = [];
    const res = await onRequestDelete({
      request: post({ token }, {}, "DELETE"),
      env: { DB: fakeDb(calls) }
    });
    assert.equal(res.status, 400, String(token));
    assert.equal(calls.length, 0);
  }
});

test("removal refuses foreign origins, non-JSON bodies and a missing DB", async () => {
  const calls = [];
  let res = await onRequestDelete({
    request: post({ token: TOKEN }, { origin: "https://evil.example" }, "DELETE"),
    env: { DB: fakeDb(calls) }
  });
  assert.equal(res.status, 403);
  res = await onRequestDelete({
    request: post({ token: TOKEN }, { "content-type": "text/plain" }, "DELETE"),
    env: { DB: fakeDb(calls) }
  });
  assert.equal(res.status, 415);
  assert.equal(calls.length, 0);
  res = await onRequestDelete({ request: post({ token: TOKEN }, {}, "DELETE"), env: {} });
  assert.equal(res.status, 503);
});

test("bad email gets 400 and stores nothing", async () => {
  const calls = [];
  const res = await onRequestPost({
    request: post({ email: "not-an-email" }),
    env: { DB: fakeDb(calls) }
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
  assert.equal(calls.length, 0);
});

test("honeypot returns 200 but stores nothing", async () => {
  const calls = [];
  const res = await onRequestPost({
    request: post({ email: "bot@example.com", website: "https://spam.example" }),
    env: { DB: fakeDb(calls) }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(calls.length, 0);
});

test("non-POST methods get 405", async () => {
  const res = await onRequest({ request: new Request(URL, { method: "GET" }), env: {} });
  assert.equal(res.status, 405);
});

test("foreign Origin is rejected", async () => {
  const calls = [];
  const res = await onRequestPost({
    request: post({ email: "a@b.co" }, { origin: "https://evil.example" }),
    env: { DB: fakeDb(calls) }
  });
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("missing DB binding returns 503", async () => {
  const res = await onRequestPost({
    request: post({ email: "a@b.co" }),
    env: {}
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).ok, false);
});

test("invalid role gets 400", async () => {
  const calls = [];
  const res = await onRequestPost({
    request: post({ email: "a@b.co", role: "admin" }),
    env: { DB: fakeDb(calls) }
  });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("a body that is not declared as JSON gets 415 and stores nothing", async () => {
  // What a cross-site <form enctype="text/plain"> could send without a CORS preflight.
  for (const type of ["text/plain", "application/x-www-form-urlencoded", null]) {
    const calls = [];
    const headers = type ? { "content-type": type } : {};
    const request = new Request(URL, { method: "POST", headers, body: '{"email":"a@b.co"}' });
    if (!type) request.headers.delete("content-type");
    const res = await onRequestPost({ request, env: { DB: fakeDb(calls) } });
    assert.equal(res.status, 415, String(type));
    assert.equal(calls.length, 0);
  }
  const ok = await onRequestPost({
    request: post({ email: "a@b.co" }, { "content-type": "application/json; charset=utf-8" }),
    env: { DB: fakeDb([]) }
  });
  assert.equal(ok.status, 200);
});

test("an oversized body gets 413 and stores nothing", async () => {
  const calls = [];
  const res = await onRequestPost({
    request: post({ email: "a@b.co", role: "", pad: "x".repeat(5000) }),
    env: { DB: fakeDb(calls) }
  });
  assert.equal(res.status, 413);
  assert.equal(calls.length, 0);
});

test("responses are never cached or sniffed", async () => {
  for (const res of [
    await onRequestPost({ request: post({ email: "a@b.co" }), env: { DB: fakeDb([]) } }),
    await onRequestPost({ request: post({ email: "nope" }), env: {} }),
    await onRequestDelete({ request: post({ token: TOKEN }, {}, "DELETE"), env: { DB: fakeDb([]) } }),
    onRequest()
  ]) {
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  }
});
