// Security in the browser: the page must escape whatever the data files contain, the CSP in
// site/_headers must let the page work while blocking injected script, and CSV downloads
// must not carry spreadsheet formulas.
// Needs Playwright with Chromium: node --test tests/browser/*.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { startServer, openPage } from "./server.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/data/${name}`, import.meta.url), "utf8"));

let browser, server;
before(async () => {
  server = await startServer();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

// Serves the given summary and revisions in place of the fixtures.
const serve = (files) => ({
  match: "**/data/*.json",
  handle: (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    route.fulfill({ contentType: "application/json", body: JSON.stringify(files[name]) });
  }
});

const PAYLOAD = `"'><img src=x onerror="window.__xss=(window.__xss||0)+1"><svg onload="window.__xss=(window.__xss||0)+1">`;
const TIME = /(_at|_since|^day|^interval_start)$/;

// Puts the payload into every string (except times, so rendering gets past date checks) or in
// place of every number; "schema" stays 1 so the page accepts the file.
function poison(value, mode, key) {
  if (Array.isArray(value)) return value.map((v) => poison(v, mode, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "schema" ? v : poison(v, mode, k)]));
  }
  if (typeof value === "string" && mode === "strings" && !TIME.test(key)) return value + PAYLOAD;
  if (typeof value === "number" && mode === "numbers") return PAYLOAD;
  return value;
}

for (const mode of ["strings", "numbers"]) {
  test(`markup in the data files is shown as text, never run (payload in ${mode})`, async () => {
    // The CSP is switched off here, so this checks the page's own escaping, not the policy.
    const files = { "summary.json": poison(fixture("summary.json"), mode), "revisions.json": poison(fixture("revisions.json"), mode) };
    const { page, close } = await openPage(browser, `${server.origin}/`, { route: serve(files), contextOptions: { bypassCSP: true } });
    try {
      await page.locator("#stats").waitFor({ state: "visible" });
      // Tooltips and menus build HTML too.
      for (const el of (await page.locator("[data-tip], .term").all()).slice(0, 60)) await el.focus().catch(() => {});
      for (const el of await page.locator('[data-role="cols"], #zp-btn').all()) await el.click().catch(() => {});
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      assert.equal(await page.locator('img[src="x"], svg[onload]').count(), 0);
      if (mode === "strings") assert.ok((await page.locator("body").innerText()).includes("<img src=x"));
    } finally {
      await close();
    }
  });
}

test("the Content-Security-Policy is sent and blocks injected script", async () => {
  const res = await (await browser.newContext()).request.get(`${server.origin}/`);
  assert.match(res.headers()["content-security-policy"], /script-src 'self' 'sha256-/);
  assert.equal(res.headers()["x-frame-options"], "DENY");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${server.origin}/`);
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", '<img src="x" onerror="window.__xss=1">');
      const s = document.createElement("script");
      s.textContent = "window.__xss = 2";
      document.body.append(s);
    });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
  } finally {
    await context.close();
  }
});

test("the inline theme script is allowed by the policy", async () => {
  const { page, context, close } = await openPage(browser, "about:blank");
  try {
    await context.addInitScript(() => localStorage.setItem("nbw.theme", JSON.stringify("dark")));
    await page.goto(`${server.origin}/`);
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
  } finally {
    await close();
  }
});

test("CSV downloads quote text that a spreadsheet would run as a formula", async () => {
  const revisions = fixture("revisions.json");
  revisions.revisions[0].zone = '=HYPERLINK("https://evil.example","x")';
  revisions.revisions[1].zone = "@SUM(1+1)";
  const files = { "summary.json": fixture("summary.json"), "revisions.json": revisions };
  const { page, close } = await openPage(browser, `${server.origin}/`, { route: serve(files) });
  try {
    await page.locator("#rev-table table").waitFor();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator('#rev-table [data-role="csv"]').click()
    ]);
    const chunks = [];
    for await (const c of await download.createReadStream()) chunks.push(c);
    const csv = Buffer.concat(chunks).toString("utf8");
    assert.match(csv, /"'=HYPERLINK\(""https:\/\/evil\.example"",""x""\)"/);
    assert.match(csv, /,'@SUM\(1\+1\),/);
    const lines = csv.trim().split("\n").slice(1);
    assert.ok(lines.length >= 6);
    // Numbers stay numbers, negative ones included.
    assert.ok(!lines.some((l) => l.split(",").some((cell) => /^'-?\d/.test(cell))));
  } finally {
    await close();
  }
});
