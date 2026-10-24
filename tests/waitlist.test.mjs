import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestPost, onRequest } from "../functions/api/waitlist.js";

const URL = "https://nbw.example.pages.dev/api/waitlist";

function fakeDb(calls) {
  return {
    prepare(sql) {
      const entry = { sql, args: null };
      calls.push(entry);
      return {
        bind(...args) {
          entry.args = args;
          return { run: async () => ({ success: true, meta: { changes: 1 } }) };
        }
      };
    }
  };
}

function post(body, headers = {}) {
  return new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

test("valid signup is stored lower-cased and returns ok", async () => {
  const calls = [];
  const res = await onRequestPost({
    request: post({ email: "  Trader@Example.COM ", role: "trader", website: "" }),
    env: { DB: fakeDb(calls) }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO waitlist/);
  assert.match(calls[0].sql, /ON CONFLICT\(email\) DO NOTHING/);
  assert.equal(calls[0].args[0], "trader@example.com");
  assert.equal(calls[0].args[1], "trader");
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
