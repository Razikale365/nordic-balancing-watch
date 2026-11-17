import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkOnce,
  dataProblem,
  decide,
  isWeeklyTest,
  lastMonitoringRun,
  MAX_AGE_MINUTES,
  TEST_RUN_NAME
} from "../watchdog/watchdog.mjs";

const NOW = Date.parse("2026-11-17T12:00:00Z"); // a Tuesday
const MONDAY_NOON = Date.parse("2026-11-16T12:00:00Z");
const ENV = {
  DATA_URL: "https://nbw.example.pages.dev/data/summary.json",
  GITHUB_REPO: "owner/repo",
  WORKFLOW: "freshness.yml",
  GITHUB_REF: "main",
  GITHUB_TOKEN: "test-token"
};
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();
const run = (minutes, conclusion = "success", status = "completed", extra = {}) => ({
  created_at: minutesAgo(minutes),
  status,
  conclusion,
  head_branch: "main",
  display_title: "Data freshness",
  ...extra
});
const FRESH = { generated_at: minutesAgo(10) };
const STALE = { generated_at: minutesAgo(391) };

// A fetch stand-in: answers the data URL with `summary`, the run list with `lastRun`, and records
// every call.
function fakeFetch({ summary, status = 200, lastRun = null, runs = null, dispatchStatus = 204 }) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    if (url === ENV.DATA_URL) {
      if (summary instanceof Error) throw summary;
      const body = typeof summary === "string" ? summary : JSON.stringify(summary);
      return new Response(body, { status });
    }
    if (url.includes("/runs?")) {
      return Response.json({ workflow_runs: runs ?? (lastRun ? [lastRun] : []) });
    }
    if (url.endsWith("/dispatches")) return new Response(null, { status: dispatchStatus });
    throw new Error(`unexpected ${url}`);
  };
  const dispatches = () => calls.filter((c) => c.method === "POST").map((c) => JSON.parse(c.body));
  return { impl, calls, dispatches };
}

test("data at the age limit is fresh, one minute more is stale", async () => {
  const atLimit = fakeFetch({ summary: { generated_at: minutesAgo(MAX_AGE_MINUTES) } });
  assert.equal(await dataProblem(atLimit.impl, ENV.DATA_URL, NOW), null);
  const over = fakeFetch({ summary: { generated_at: minutesAgo(MAX_AGE_MINUTES + 1) } });
  assert.match(await dataProblem(over.impl, ENV.DATA_URL, NOW), /46 minutes old/);
});

test("unreadable data counts as stale", async () => {
  for (const [summary, status, reason] of [
    [new Error("network down"), 200, /could not fetch/],
    ["<html>", 200, /not valid JSON/],
    [FRESH, 404, /HTTP 404/],
    [{}, 200, /no valid generated_at/]
  ]) {
    const { impl } = fakeFetch({ summary, status });
    assert.match(await dataProblem(impl, ENV.DATA_URL, NOW), reason);
  }
});

test("the full check runs every hour, also when the data is fresh", async () => {
  const due = fakeFetch({ summary: FRESH, lastRun: run(61) });
  assert.equal(await checkOnce(ENV, due.impl, NOW), "hourly");
  assert.deepEqual(due.dispatches(), [{ ref: "main" }]);
  const dispatch = due.calls.at(-1);
  assert.equal(
    dispatch.url,
    "https://api.github.com/repos/owner/repo/actions/workflows/freshness.yml/dispatches"
  );
  assert.equal(dispatch.headers.authorization, "Bearer test-token");
  assert.ok(dispatch.headers["user-agent"]);

  // A run created seconds after the tick an hour ago is just under 60 minutes old; it is due.
  const justUnder = fakeFetch({ summary: FRESH, lastRun: run(59.9) });
  assert.equal(await checkOnce(ENV, justUnder.impl, NOW), "hourly");

  const notDue = fakeFetch({ summary: FRESH, lastRun: run(45) });
  assert.equal(await checkOnce(ENV, notDue.impl, NOW), "nothing");
  assert.deepEqual(notDue.dispatches(), []);

  const never = fakeFetch({ summary: FRESH });
  assert.equal(await checkOnce(ENV, never.impl, NOW), "hourly");
});

test("stale data starts a run at once, unless the last run already failed or is running", async () => {
  const afterPass = fakeFetch({ summary: STALE, lastRun: run(10, "success") });
  assert.equal(await checkOnce(ENV, afterPass.impl, NOW), "stale");
  assert.deepEqual(afterPass.dispatches(), [{ ref: "main" }]);

  const afterFail = fakeFetch({ summary: STALE, lastRun: run(10, "failure") });
  assert.equal(await checkOnce(ENV, afterFail.impl, NOW), "nothing");

  const running = fakeFetch({ summary: STALE, lastRun: run(2, null, "in_progress") });
  assert.equal(await checkOnce(ENV, running.impl, NOW), "nothing");

  // While the problem lasts, the hourly run keeps failing, and so keeps sending emails.
  const hourLater = fakeFetch({ summary: STALE, lastRun: run(60, "failure") });
  assert.equal(await checkOnce(ENV, hourLater.impl, NOW), "stale");
});

test("the weekly test and runs on other branches never hide a stale alert", async () => {
  const runs = [
    run(5, "failure", "completed", { display_title: TEST_RUN_NAME }),
    run(10, "failure", "completed", { head_branch: "some-feature" }),
    run(20, "success")
  ];
  const { impl, calls, dispatches } = fakeFetch({ summary: STALE, runs });
  assert.deepEqual(await lastMonitoringRun(ENV, impl), runs[2]);
  assert.equal(await checkOnce(ENV, impl, NOW), "stale");
  assert.deepEqual(dispatches(), [{ ref: "main" }]);
  assert.ok(calls.some((c) => c.url.includes("event=workflow_dispatch&branch=main&")));
});

test("the first tick on Monday from 12:00 UTC starts the weekly test alert", async () => {
  assert.equal(isWeeklyTest(MONDAY_NOON), true);
  assert.equal(isWeeklyTest(MONDAY_NOON + 14 * 60000), true);
  assert.equal(isWeeklyTest(MONDAY_NOON + 15 * 60000), false);
  assert.equal(isWeeklyTest(MONDAY_NOON - 15 * 60000), false);
  assert.equal(isWeeklyTest(NOW), false); // Tuesday noon

  const { impl, dispatches } = fakeFetch({ summary: FRESH, lastRun: run(5) });
  assert.equal(await checkOnce(ENV, impl, MONDAY_NOON, MONDAY_NOON), "test");
  assert.deepEqual(dispatches(), [{ ref: "main", inputs: { test_alert: "true" } }]);
});

test("decide covers each case without network calls", () => {
  assert.equal(decide({ problem: null, lastRun: run(30), now: NOW, weeklyTest: false }), null);
  assert.equal(decide({ problem: "x", lastRun: undefined, now: NOW, weeklyTest: false }), "stale");
  assert.equal(decide({ problem: null, lastRun: run(30), now: NOW, weeklyTest: true }), "test");
});

test("without a token, nothing is started", async () => {
  const { impl, calls } = fakeFetch({ summary: STALE });
  const { GITHUB_TOKEN, ...noToken } = ENV;
  assert.equal(await checkOnce(noToken, impl, NOW), "no token");
  assert.equal(calls.length, 1);
});

test("a rejected request fails the tick, so it shows in the Worker's logs", async () => {
  const { impl } = fakeFetch({ summary: STALE, lastRun: run(90), dispatchStatus: 401 });
  await assert.rejects(checkOnce(ENV, impl, NOW), /HTTP 401/);
});
