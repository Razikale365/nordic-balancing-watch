import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { onRequestGet } from "../functions/data/[name].js";

const BASE = "https://raw.example/data";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function get(name, env) {
  const request = new Request(`https://nbw.example.pages.dev/data/${name}`);
  return onRequestGet({ request, env, params: { name } });
}

test("serves a valid file from the data branch with a cache header", async () => {
  globalThis.fetch = async (url) => {
    assert.equal(url, `${BASE}/summary.json`);
    return new Response(JSON.stringify({ schema: 1, groups: [] }));
  };
  const res = await get("summary.json", { DATA_BASE_URL: BASE });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control"), /max-age=300/);
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal((await res.json()).schema, 1);
});

test("unknown file names are 404 and never fetched", async () => {
  globalThis.fetch = async () => assert.fail("fetched");
  const res = await get("secrets.json", { DATA_BASE_URL: BASE });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
});

test("bad upstream data is 502", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ schema: 2 }));
  assert.equal((await get("revisions.json", { DATA_BASE_URL: BASE })).status, 502);
  globalThis.fetch = async () => new Response("not json");
  assert.equal((await get("revisions.json", { DATA_BASE_URL: BASE })).status, 502);
  globalThis.fetch = async () => new Response("gone", { status: 404 });
  assert.equal((await get("revisions.json", { DATA_BASE_URL: BASE })).status, 502);
});

test("without a data source it serves the static file", async () => {
  const env = { ASSETS: { fetch: async () => new Response("static") } };
  assert.equal(await (await get("summary.json", env)).text(), "static");
});
