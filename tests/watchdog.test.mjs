import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOnce, dataProblem, MAX_AGE_MINUTES } from "../watchdog/watchdog.mjs";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const ENV = {
  DATA_URL: "https://nbw.example.pages.dev/data/summary.json",
  GITHUB_REPO: "owner/repo",
  WORKFLOW: "freshness.yml",
  GITHUB_REF: "main",
  GITHUB_TOKEN: "test-token"
};
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();

// A fetch stand-in: answers the data URL with `summary`, the run list with `lastRun`, and records
// every call.
function fakeFetch({ summary, status = 200, lastRun = null, dispatchStatus = 204 }) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    if (url === ENV.DATA_URL) {
      if (summary instanceof Error) throw summary;
      const body = typeof summary === "string" ? summary : JSON.stringify(summary);
      return new Response(body, { status });
    }
    if (url.includes("/runs?")) {
      return Response.json({ workflow_runs: lastRun ? [lastRun] : [] });
    }
    if (url.endsWith("/dispatches")) return new Response(null, { status: dispatchStatus });
    throw new Error(`unexpected ${url}`);
  };
  return { impl, calls };
}

test("fresh data starts nothing", async () => {
  const { impl, calls } = fakeFetch({ summary: { generated_at: minutesAgo(MAX_AGE_MINUTES) } });
  assert.equal(await checkOnce(ENV, impl, NOW), "fresh");
  assert.equal(calls.length, 1);
});

test("stale data starts the freshness workflow on main", async () => {
  const { impl, calls } = fakeFetch({ summary: { generated_at: minutesAgo(391) } });
  assert.equal(await checkOnce(ENV, impl, NOW), "alerted");
  const dispatch = calls.at(-1);
  assert.equal(dispatch.method, "POST");
  assert.equal(
    dispatch.url,
    "https://api.github.com/repos/owner/repo/actions/workflows/freshness.yml/dispatches"
  );
  assert.deepEqual(JSON.parse(dispatch.body), { ref: "main" });
  assert.equal(dispatch.headers.authorization, "Bearer test-token");
  assert.ok(dispatch.headers["user-agent"]);
});

test("a stale alert is not repeated within two hours", async () => {
  const recent = fakeFetch({
    summary: { generated_at: minutesAgo(200) },
    lastRun: { created_at: minutesAgo(90) }
  });
  assert.equal(await checkOnce(ENV, recent.impl, NOW), "alerted recently");
  assert.ok(!recent.calls.some((c) => c.method === "POST"));

  const old = fakeFetch({
    summary: { generated_at: minutesAgo(200) },
    lastRun: { created_at: minutesAgo(125) }
  });
  assert.equal(await checkOnce(ENV, old.impl, NOW), "alerted");
});

test("unreadable data counts as stale", async () => {
  for (const [summary, status, reason] of [
    [new Error("network down"), 200, /could not fetch/],
    ["<html>", 200, /not valid JSON/],
    [{ generated_at: minutesAgo(5) }, 404, /HTTP 404/],
    [{}, 200, /no valid generated_at/]
  ]) {
    const { impl } = fakeFetch({ summary, status });
    assert.match(await dataProblem(impl, ENV.DATA_URL, NOW), reason);
    assert.equal(await checkOnce(ENV, impl, NOW), "alerted");
  }
});

test("without a token, stale data is only logged", async () => {
  const { impl, calls } = fakeFetch({ summary: { generated_at: minutesAgo(391) } });
  const { GITHUB_TOKEN, ...noToken } = ENV;
  assert.equal(await checkOnce(noToken, impl, NOW), "no token");
  assert.equal(calls.length, 1);
});

test("a rejected dispatch fails the check, so it shows in the Worker's logs", async () => {
  const { impl } = fakeFetch({ summary: { generated_at: minutesAgo(391) }, dispatchStatus: 401 });
  await assert.rejects(checkOnce(ENV, impl, NOW), /HTTP 401/);
});
