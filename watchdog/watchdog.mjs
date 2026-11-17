// A Cloudflare Worker that checks every 15 minutes how old the site's data is. When the data is
// too old, or cannot be read, it starts the Data freshness workflow, which then fails, and GitHub
// emails the owner about the failed run. GitHub runs that workflow's own schedule only every few
// hours at busy times, so on its own a stalled collector can go unnoticed for most of a day.

export const MAX_AGE_MINUTES = 45; // the same limit as scripts/check_live.py
export const ALERT_EVERY_MINUTES = 120; // while the data stays stale, one failed run per two hours

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

// One check. Returns what it did: "fresh", "no token", "alerted recently" or "alerted".
export async function checkOnce(env, fetchImpl = fetch, now = Date.now()) {
  const problem = await dataProblem(fetchImpl, env.DATA_URL, now);
  if (!problem) return "fresh";
  if (!env.GITHUB_TOKEN) {
    console.error(`Stale data (${problem}), but no GITHUB_TOKEN secret is set to start ${env.WORKFLOW}`);
    return "no token";
  }
  const runs = await workflowApi(env, fetchImpl, "/runs?event=workflow_dispatch&per_page=1");
  if (!runs.ok) throw new Error(`Listing ${env.WORKFLOW} runs returned HTTP ${runs.status}`);
  const last = (await runs.json()).workflow_runs?.[0];
  if (last && now - Date.parse(last.created_at) < ALERT_EVERY_MINUTES * 60000) {
    return "alerted recently";
  }
  const started = await workflowApi(env, fetchImpl, "/dispatches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: env.GITHUB_REF })
  });
  if (!started.ok) throw new Error(`Starting ${env.WORKFLOW} returned HTTP ${started.status}`);
  console.log(`Started ${env.WORKFLOW}: ${problem}`);
  return "alerted";
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(checkOnce(env));
  }
};
