// A Cloudflare Worker that runs every 15 minutes and starts the Data freshness workflow. GitHub
// notifies the token's owner of failed runs (by email when their Actions notification settings
// say so). On 2026-11-17 GitHub ran that workflow's own schedule only about every eight hours,
// so on its own a stalled collector could go unnoticed for most of a day.
//
// The Worker starts the workflow
// - about every hour, so all of scripts/check_live.py's checks run, not only the data's age;
// - at once when the data is too old or cannot be read, unless the last monitoring run already
//   failed (and so already notified); while the problem lasts, the hourly runs keep failing;
// - on Mondays at 12:00 UTC with test_alert set, so that run fails on purpose and its
//   notification shows that the whole chain still works.
// Only runs on the monitored branch count, and the weekly test run is never one of them.

export const MAX_AGE_MINUTES = 45; // the same limit as scripts/check_live.py
export const FULL_CHECK_EVERY_MINUTES = 60;
// A run is created a few seconds after the tick that started it, so the tick an hour later finds
// it just under 60 minutes old; without this slack the hourly check would slip to every 75.
export const SLACK_MINUTES = 5;
export const TEST_RUN_NAME = "Weekly alert test (fails on purpose)"; // run-name in freshness.yml

// Returns why the data looks stale, or null when it is fresh.
export async function dataProblem(fetchImpl, dataUrl, now) {
  let res;
  try {
    res = await fetchImpl(dataUrl, { headers: { accept: "application/json" } });
  } catch (err) {
    return `could not fetch ${dataUrl}: ${err.message}`;
  }
  if (!res.ok) return `${dataUrl} returned HTTP ${res.status}`;
  let summary;
  try {
    summary = await res.json();
  } catch {
    return `${dataUrl} is not valid JSON`;
  }
  const generated = Date.parse(summary?.generated_at ?? "");
  if (Number.isNaN(generated)) return `${dataUrl} has no valid generated_at`;
  const minutes = Math.floor((now - generated) / 60000);
  return minutes > MAX_AGE_MINUTES ? `the data is ${minutes} minutes old (limit ${MAX_AGE_MINUTES})` : null;
}

// The tick that starts the weekly test: the first one on a Monday from 12:00 UTC.
export function isWeeklyTest(scheduledTime) {
  const t = new Date(scheduledTime);
  return t.getUTCDay() === 1 && t.getUTCHours() === 12 && t.getUTCMinutes() < 15;
}

// What to start, given the data's problem (or null), the newest workflow_dispatch run (or
// undefined) and the time: "test", "stale", "hourly" or null for nothing.
export function decide({ problem, lastRun, now, weeklyTest }) {
  if (weeklyTest) return "test";
  const lastAge = lastRun ? now - Date.parse(lastRun.created_at) : Infinity;
  if (lastAge >= (FULL_CHECK_EVERY_MINUTES - SLACK_MINUTES) * 60000) return problem ? "stale" : "hourly";
  // A run that is still going, or that failed, has the problem in hand: it fails, or already
  // failed and sent its email. Only a run that passed has not told anyone yet.
  if (problem && lastRun.status === "completed" && lastRun.conclusion === "success") return "stale";
  return null;
}

function workflowApi(env, fetchImpl, path, init = {}) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW}${path}`;
  return fetchImpl(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "user-agent": "nbw-stale-data-alert",
      "x-github-api-version": "2022-11-28",
      ...init.headers
    }
  });
}

// The newest workflow_dispatch run on the monitored branch that is not the weekly test, or
// undefined. GitHub lists runs newest first.
export async function lastMonitoringRun(env, fetchImpl) {
  const query = `?event=workflow_dispatch&branch=${encodeURIComponent(env.GITHUB_REF)}&per_page=20`;
  const res = await workflowApi(env, fetchImpl, `/runs${query}`);
  if (!res.ok) throw new Error(`Listing ${env.WORKFLOW} runs returned HTTP ${res.status}`);
  const runs = (await res.json()).workflow_runs ?? [];
  return runs.find((r) => r.head_branch === env.GITHUB_REF && r.display_title !== TEST_RUN_NAME);
}

// One tick. Returns what it started ("test", "stale" or "hourly"), or "nothing" or "no token".
export async function checkOnce(env, fetchImpl = fetch, now = Date.now(), scheduledTime = now) {
  const problem = await dataProblem(fetchImpl, env.DATA_URL, now);
  if (!env.GITHUB_TOKEN) {
    if (problem) console.error(`Stale data (${problem}), but no GITHUB_TOKEN secret is set`);
    return "no token";
  }
  const lastRun = await lastMonitoringRun(env, fetchImpl);
  const action = decide({ problem, lastRun, now, weeklyTest: isWeeklyTest(scheduledTime) });
  if (!action) return "nothing";
  const body = { ref: env.GITHUB_REF };
  if (action === "test") body.inputs = { test_alert: "true" };
  const started = await workflowApi(env, fetchImpl, "/dispatches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!started.ok) throw new Error(`Starting ${env.WORKFLOW} returned HTTP ${started.status}`);
  console.log(`Started ${env.WORKFLOW} (${action})${problem ? `: ${problem}` : ""}`);
  return action;
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(checkOnce(env, fetch, Date.now(), controller.scheduledTime));
  }
};
