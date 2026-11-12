// The page in a real browser: the explanations must stay readable when JavaScript is off, when
// the script fails to load and when the data files cannot be fetched; with data, everything shows.
// Needs Playwright with Chromium: node --test tests/browser/*.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { startServer, openPage } from "./server.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");

let browser, server, origin;
before(async () => {
  server = await startServer();
  origin = server.origin;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

// Opens the home page under the site's real security headers; `route` can fail requests.
const open = (options) => openPage(browser, `${origin}/`, options);

// What a reader must always get, whatever happens to the scripts or the data.
async function assertExplanationsVisible(page) {
  const h1 = page.locator("h1");
  assert.equal(await h1.count(), 1);
  assert.ok(await h1.isVisible());
  assert.match(await h1.innerText(), /When Nordic balancing prices appear/);
  assert.ok(await page.locator(".lede").isVisible());
  assert.ok(await page.getByRole("heading", { name: "What is an imbalance price?" }).isVisible());
  for (const id of ["now", "imbalance", "reserves", "revisions", "data"]) {
    assert.ok(await page.locator(`#${id} .section-head h2`).isVisible(), `#${id} heading hidden`);
  }
  assert.ok(await page.locator(".method").isVisible());
  const entries = page.locator("#glossary > div");
  assert.ok((await entries.count()) >= 15);
  assert.ok(await page.locator("#g-imbalance dd").isVisible());
  assert.ok(await page.locator("#cite-text").isVisible());
  assert.match(await page.locator("#cite-text").innerText(), /Nordic Balancing Watch/);
}

async function assertDataBlocksHidden(page) {
  for (const el of await page.locator("[data-needs-data]").all()) {
    assert.equal(await el.isVisible(), false);
  }
  assert.equal(await page.getByText("Live", { exact: true }).isVisible(), false);
}

test("with JavaScript off, the explanations are readable and the data files are linked", async () => {
  const { page, close } = await open({ javaScriptEnabled: false });
  try {
    await assertExplanationsVisible(page);
    await assertDataBlocksHidden(page);
    const notice = page.locator("noscript + *, .data-notice").filter({ hasText: "need JavaScript" });
    assert.ok(await notice.isVisible());
    assert.ok(await notice.getByRole("link", { name: "summary.json" }).isVisible());
    assert.equal(await page.locator("#empty-state").isVisible(), false);
    assert.equal(await page.locator("#cite-copy").isVisible(), false);
    assert.match(await page.locator("#coverage-note").innerText(), /^Collection started on 24 October 2026\./);
  } finally {
    await close();
  }
});

for (const [name, handle] of [
  ["return an error", (r) => r.fulfill({ status: 502, contentType: "application/json", body: '{"ok":false}' })],
  ["cannot be reached", (r) => r.abort("connectionfailed")],
  ["are not schema-1 data", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"schema":2}' })]
]) {
  test(`when the data files ${name}, the explanations stay and a notice says why figures are missing`, async () => {
    const { page, errors, close } = await open({ route: { match: "**/data/*.json", handle } });
    try {
      await page.locator("#empty-state").waitFor({ state: "visible" });
      await assertExplanationsVisible(page);
      await assertDataBlocksHidden(page);
      assert.match(await page.locator("#empty-state").innerText(), /could not be loaded/);
      // The citation still works, just without the collection start date.
      assert.ok(await page.locator("#cite-copy").isVisible());
      assert.match(await page.locator("#cite-text").innerText(), /\(accessed /);
      // Glossary tooltips still come from the page's own glossary.
      assert.match(await page.locator('.explain .term[data-term="imbalance"]').getAttribute("aria-label"), /^imbalance\s+price: The price paid/);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });
}

test("when the script itself fails to load, the explanations stay", async () => {
  const { page, close } = await open({ route: { match: "**/app.js", handle: (r) => r.abort() } });
  try {
    await assertExplanationsVisible(page);
    await assertDataBlocksHidden(page);
  } finally {
    await close();
  }
});

test("with data, the figures, charts and tables appear and the notice does not", async () => {
  const { page, errors, close } = await open();
  try {
    await page.locator("#stats").waitFor({ state: "visible" });
    await assertExplanationsVisible(page);
    for (const el of await page.locator("[data-needs-data]").all()) {
      assert.ok(await el.isVisible(), await el.evaluate((e) => e.outerHTML.slice(0, 80)));
    }
    assert.equal(await page.locator("#empty-state").isVisible(), false);
    assert.ok((await page.locator("#findings li").count()) > 0);
    assert.ok((await page.locator("#delay-chart svg").count()) > 0);
    assert.ok((await page.locator("#zones-table table tbody tr").count()) > 0);
    assert.match(await page.locator("#status-line").innerText(), /updated/);
    assert.match(await page.locator("#cite-text").innerText(), /collected since 21 October 2026/);
    // The data's start date replaces the page's own sentence instead of repeating it.
    const notCounted = await page.locator(".method .card").filter({ hasText: "What is not counted" }).innerText();
    assert.equal(notCounted.match(/Collection started on/g).length, 1, notCounted);
    assert.match(notCounted, /Collection started on 21 Oct 2026/);
    // Terms added by the script get their definitions from the glossary in the page too.
    const dynamic = page.locator('#findings .term, #stats .term, #board-note .term, #lead-pending .term').first();
    if (await dynamic.count()) assert.match(await dynamic.getAttribute("aria-label"), /: \S/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// The tile divides prices changed later by prices first seen, summed over the imbalance series
// in the window; the fixture's totals are moved onto one series so each case is exact.
const SUMMARY = JSON.parse(readFileSync(new URL("../fixtures/data/summary.json", import.meta.url), "utf8"));
function summaryWith(published, revised) {
  const s = structuredClone(SUMMARY);
  s.groups.filter((g) => g.data === "imbalance").forEach((g, i) => {
    g.last7.published = i ? 0 : published;
    g.last7.revised = i ? 0 : revised;
  });
  return JSON.stringify(s);
}

for (const [label, published, revised, value, sub] of [
  ["none changed", 1000, 0, "0.0%", "0 of 1,000 imbalance prices"],
  ["a few in many changed", 17751, 7, "<0.1%", "7 of 17,751 imbalance prices"],
  ["a usual share changed", 10000, 1234, "12.3%", "1,234 of 10,000 imbalance prices"],
  ["nothing was first seen", 0, 0, null, null]
]) {
  test(`the share of first prices changed so far when ${label}`, async () => {
    const handle = (r) => r.fulfill({ status: 200, contentType: "application/json", body: summaryWith(published, revised) });
    const { page, errors, close } = await open({ route: { match: "**/data/summary.json", handle } });
    try {
      await page.locator("#stats .stat").first().waitFor();
      const tile = page.locator("#stats .stat").filter({ hasText: "First prices changed so far" });
      if (value == null) {
        assert.equal(await tile.count(), 0);
      } else {
        assert.equal(await tile.locator(".v").innerText(), value);
        assert.equal(await tile.locator(".s").innerText(), sub);
      }
      assert.doesNotMatch(await page.locator("#stats").innerText(), /NaN|Infinity/);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });
}

// Serves the fixture summary after `change` has edited a copy of it.
function routeSummary(change) {
  const s = structuredClone(SUMMARY);
  change(s);
  return { match: "**/data/summary.json", handle: (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(s) }) };
}
const group = (s, source, zone) => s.groups.find((g) => g.data === "imbalance" && g.source === source && g.zone === zone);
// The three imbalance series of the fixture, each with its slowest price on the same interval.
function shareSlowest(s) {
  for (const [source, zone, max] of [["esett", "DK1", 615], ["esett", "DK2", 430], ["entsoe", "FI", 400]]) {
    Object.assign(group(s, source, zone).last7, { max, max_start: "2026-10-23T02:15:00Z" });
  }
}

test("when the slowest price of several sources is the same interval, the findings and the outlier note say so", async () => {
  const { page, errors, close } = await open({ route: routeSummary(shareSlowest) });
  try {
    await page.locator("#findings li").first().waitFor();
    const found = (await page.locator("#findings li").allInnerTexts()).filter((t) => /^One 15-minute price/.test(t));
    assert.equal(found.length, 1);
    assert.equal(found[0], "One 15-minute price, the one starting 23 Oct, 02:15 UTC, first appeared 7–10 h after it ended at every source: " +
      "eSett (DK1, DK2) and ENTSO-E (FI), so the delay began before publication rather than at one publisher.");
    assert.equal(await page.locator("#delay-callout").innerText(), "Outlier: one 15-minute price, the one starting 23 Oct, 02:15 UTC, " +
      "took 7–10 h to appear at eSett (DK1, DK2) and ENTSO-E (FI) alike, against 95th percentiles of 88–96 min.");
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("a shared slowest interval does not say every source when one zone of a source does not share it", async () => {
  // Every source category shares the interval, but eSett DK2's slowest price was another one.
  const route = routeSummary((s) => {
    shareSlowest(s);
    Object.assign(group(s, "esett", "DK2").last7, { max: 500, max_start: "2026-10-22T10:00:00Z" });
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#stats .stat").first().waitFor();
    const found = (await page.locator("#findings li").allInnerTexts()).filter((t) => /^One 15-minute price/.test(t));
    assert.equal(found.length, 1);
    assert.match(found[0], /after it ended at eSett \(DK1\) and ENTSO-E \(FI\), so the delay began before publication/);
    assert.doesNotMatch(found[0], /every source/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("a shared slowest interval does not say every source when a source category does not share it", async () => {
  const route = routeSummary((s) => {
    shareSlowest(s);
    const fin = structuredClone(group(s, "entsoe", "FI"));
    s.groups.push(Object.assign(fin, { source: "fingrid" }));
    fin.last7.max_start = "2026-10-22T10:00:00Z";
    s.groups.sort((a, b) => (a.source + a.data + a.zone < b.source + b.data + b.zone ? -1 : 1));
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#findings li").first().waitFor();
    const found = (await page.locator("#findings li").allInnerTexts()).filter((t) => /^One 15-minute price/.test(t));
    assert.equal(found.length, 1);
    assert.match(found[0], /after it ended at eSett \(DK1, DK2\) and ENTSO-E \(FI\), so the delay began before publication/);
    assert.doesNotMatch(found[0], /every source/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

for (const [label, change] of [
  ["max_start is absent", (s) => { shareSlowest(s); s.groups.forEach((g) => delete g.last7.max_start); }],
  ["the sources do not share the interval", (s) => { shareSlowest(s); group(s, "entsoe", "FI").last7.max_start = "2026-10-22T10:00:00Z"; }],
  ["only one source category shares it", (s) => { shareSlowest(s); group(s, "entsoe", "FI").last7.max_start = null; }],
  ["the shared delay is under six hours", (s) => { shareSlowest(s); s.groups.forEach((g) => { if (g.last7.max_start) g.last7.max = 300; }); }]
]) {
  test(`the page reads as before when ${label}`, async () => {
    const { page, errors, close } = await open({ route: routeSummary(change) });
    try {
      await page.locator("#findings li").first().waitFor();
      assert.doesNotMatch(await page.locator("#findings").innerText(), /One 15-minute price/);
      assert.doesNotMatch(await page.locator("#delay-callout").innerText(), /15-minute price/);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });
}

test("without max_start the outlier note names the one series", async () => {
  const { page, close } = await open({ route: routeSummary((s) => s.groups.forEach((g) => delete g.last7.max_start)) });
  try {
    await page.locator("#findings li").first().waitFor();
    assert.equal(await page.locator("#delay-callout").innerText(), "Outlier: one eSett DK1 price took 10 h, against a 95th percentile of 92 min.");
  } finally {
    await close();
  }
});

// A small share is stated as "1 in N" with two significant digits, not rounded up to 1 in 100.
// Without 14-day-old prices the sentence is about the window's own first prices, so it says
// "so far"; the delay of other, older changes is not attached to it.
for (const [published, revised, sentence] of [
  [639, 1, "About 1 in 640 (0.2%, 1 of 639) of the first prices ENTSO-E showed for Finland (FI) have been changed so far."],
  [17773, 3, "About 1 in 5,900 (<0.1%, 3 of 17,773) of the first prices ENTSO-E showed for Finland (FI) have been changed so far."],
  [100, 12, "About 1 in 8 (12%, 12 of 100) of the first prices ENTSO-E showed for Finland (FI) have been changed so far."]
]) {
  test(`the plain-language share when ${revised} of ${published} first prices were changed`, async () => {
    const route = routeSummary((s) => {
      s.groups.filter((g) => g.data === "imbalance").forEach((g) => { g.last7.revised = 0; g.last7.revised_share = 0; });
      Object.assign(group(s, "entsoe", "FI").last7, { published, revised, revised_share: revised / published });
    });
    const { page, errors, close } = await open({ route });
    try {
      await page.locator("#findings li").first().waitFor();
      const found = (await page.locator("#findings li").allInnerTexts()).filter((t) => t.startsWith("About "));
      assert.equal(found.length, 1);
      assert.ok(found[0].startsWith(sentence), found[0]);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });
}

test("the price board gives no percentage against a previous price under 10 EUR/MWh", async () => {
  const route = routeSummary((s) => {
    Object.assign(s.now[0], { price: 70.94, prev_price: 3 });
    Object.assign(s.now[1], { price: 55, prev_price: 50 });
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#board .px").first().waitFor();
    const cells = page.locator("#board td[data-label]");
    const jump = cells.filter({ hasText: "70.94" }).locator(".chg");
    assert.equal((await jump.innerText()).replace(/\s+/g, " "), "▲ +67.94");
    assert.equal(await jump.locator(".pc").count(), 0);
    const usual = cells.filter({ hasText: "55.00" }).locator(".chg");
    assert.equal((await usual.innerText()).replace(/\s+/g, " "), "▲ +5.00 +10%");
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("the summary and the revision log are requested together, and a failed log is an empty one", async () => {
  // The summary is held back until the log has been asked for: one after the other would wait for the timeout.
  let asked;
  const logAsked = new Promise((resolve) => { asked = resolve; });
  let summaryWaitedForLog = null;
  const handle = async (r) => {
    if (r.request().url().endsWith("/revisions.json")) {
      asked(true);
      return r.abort("connectionfailed");
    }
    summaryWaitedForLog = await Promise.race([logAsked, new Promise((resolve) => setTimeout(resolve, 3000, false))]);
    return r.continue();
  };
  const { page, errors, close } = await open({ route: { match: "**/data/*.json", handle } });
  try {
    await page.locator("#stats .stat").first().waitFor();
    assert.equal(summaryWaitedForLog, true);
    assert.equal(await page.locator("#empty-state").isVisible(), false);
    assert.match(await page.locator("#rev-table").innerText(), /0 rows/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// The fixture is old, so by the real clock it is stale.
test("when the data is old, the page says so and the collector tile does not claim to be healthy", async () => {
  const { page, errors, close } = await open();
  try {
    await page.locator("#stats .stat").first().waitFor();
    const banner = page.locator("#stale-banner");
    assert.ok(await banner.isVisible());
    assert.match(await banner.innerText(), /normally refreshes every 15 minutes, so the newest prices may be missing/);
    assert.doesNotMatch(await banner.innerText(), /hourly/);
    assert.match(await page.locator("#status-line").innerText(), /^Delayed/);
    const tile = page.locator("#stats .stat").filter({ hasText: "Prices revised" });
    assert.match(await tile.locator(".tile-health").innerText(), /^No new data since 24 Oct, 19:00 UTC$/);
    assert.equal(await tile.locator(".tile-health .dot.down").count(), 1);
    assert.doesNotMatch(await tile.innerText(), /healthy|checks OK/i);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// The page's clock starts a few minutes after the summary was generated; the summary changes
// on the second request, as when the collector publishes again.
async function openWithClock(generated, later) {
  let served = 0;
  const handle = (r) => {
    const s = structuredClone(SUMMARY);
    s.generated_at = served++ ? later : generated;
    s.polls_24h = { ok: 1440, skipped: 0, error: 2 };
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(s) });
  };
  const opened = await open({ clock: new Date("2026-11-08T12:00:00Z"), route: { match: "**/data/summary.json", handle } });
  return { ...opened, served: () => served };
}

test("fresh data shows no banner and a healthy collector, and the page picks up newer data by itself", async () => {
  const { page, errors, close, served } = await openWithClock("2026-11-08T11:50:00Z", "2026-11-08T12:10:00Z");
  try {
    await page.locator("#stats .stat").first().waitFor();
    assert.equal(await page.locator("#stale-banner").isVisible(), false);
    assert.match(await page.locator("#status-line").innerText(), /^Live · updated 11:50 UTC/);
    assert.match(await page.locator("#stats .tile-health").innerText(), /^Collector healthy$/);
    // Nothing is fetched again before 15 minutes have passed.
    await page.clock.fastForward("14:00");
    assert.equal(served(), 1);
    await page.clock.fastForward("01:30");
    await page.waitForFunction(() => /updated 12:10 UTC/.test(document.querySelector("#status-line").innerText));
    assert.equal(served(), 2);
    assert.match(await page.locator("#cite-text").innerText(), /collected since 21 October 2026/);
    // The redrawn page still answers a click on the time-zone buttons.
    await page.locator('.tz button[data-tz="Europe/Stockholm"]').click();
    assert.match(await page.locator("#status-line").innerText(), /updated 13:10 CET/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("data that stops arriving turns the page to the delayed state without a reload", async () => {
  const { page, errors, close } = await openWithClock("2026-11-08T11:50:00Z", "2026-11-08T11:50:00Z");
  try {
    await page.locator("#stats .stat").first().waitFor();
    assert.equal(await page.locator("#stale-banner").isVisible(), false);
    await page.clock.fastForward("50:00");
    await page.locator("#stale-banner").waitFor({ state: "visible" });
    assert.match(await page.locator("#stats .tile-health").innerText(), /^No new data since 11:50 UTC|^No new data since 8 Nov, 11:50 UTC/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// Serves the fixture revision log after `change` has edited a copy of it.
const REVISIONS = JSON.parse(readFileSync(new URL("../fixtures/data/revisions.json", import.meta.url), "utf8"));
function routeRevisions(change) {
  const r = structuredClone(REVISIONS);
  change(r);
  return { match: "**/data/revisions.json", handle: (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(r) }) };
}
const full = (r) => { r.revisions = Array.from({ length: 500 }, () => r.revisions[0]); };

test("a log that says what it keeps is described that way", async () => {
  const route = routeRevisions((r) => {
    full(r);
    r.kept = { imbalance: 480, imbalance_total: 480, other: 20, other_total: 1200, other_since: "2026-10-23T08:30:00Z" };
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#stats .stat").first().waitFor();
    const notes = await page.locator("[data-revcap]").allInnerTexts();
    assert.equal(notes.length, 2);
    for (const note of notes) {
      // The fixture covers the first 3.5 days of collection, and the note names that window.
      assert.equal(note, "The log keeps every imbalance price change in the first 3.5 days of collection (480) and the newest 20 of 1,200 reserve price changes, " +
        "back to 23 Oct, 08:30 UTC. The revision log, its CSV and the charts built from it cover only those entries.");
    }
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("a log that had to cut imbalance changes does not claim to keep them all", async () => {
  const route = routeRevisions((r) => {
    full(r);
    r.kept = { imbalance: 500, imbalance_total: 650, other: 0, other_total: 1200, other_since: null };
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#stats .stat").first().waitFor();
    const notes = await page.locator("[data-revcap]").allInnerTexts();
    assert.equal(notes.length, 2);
    for (const note of notes) {
      assert.equal(note, "The log keeps the newest 500 of 650 imbalance price changes and the newest 0 of 1,200 reserve price changes. " +
        "The revision log, its CSV and the charts built from it cover only those entries.");
    }
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("a log that keeps everything has no note about a cap", async () => {
  const { page, errors, close } = await open();
  try {
    await page.locator("#stats .stat").first().waitFor();
    for (const note of await page.locator("[data-revcap]").allInnerTexts()) assert.equal(note, "");
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("without kept, a full log keeps the old wording", async () => {
  const route = routeRevisions((r) => { full(r); delete r.kept; });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#stats .stat").first().waitFor();
    const counted = SUMMARY.groups.reduce((n, g) => n + g.last7.revisions, 0).toLocaleString("en-GB");
    assert.equal(await page.locator("[data-revcap]").first().innerText(), "The log keeps only the newest 500 entries, back to 24 Oct, 18:44 UTC, " +
      `while ${counted} changes were counted in the window. The revision log, its CSV and the charts built from it cover only those entries.`);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// A long zone label takes the room the name and the links need on one row.
for (const [label, zones] of [["all zones", null], ["a long zone label", ["DK1", "DK2", "NO1", "NO2", "NO3", "NO4", "NO5"]]]) {
  test(`with ${label}, the section links and the name are never cut off and the top bar stays on screen at any width`, async () => {
    const { page, errors, close } = await open({ storage: zones && { "nbw.zones": zones } });
    try {
      await page.locator("#stats .stat").first().waitFor();
      const LIB = "https://github.com/Razikale365/nordic-balancing";
      assert.equal(await page.locator("#gh-btn").getAttribute("href"), LIB);
      assert.equal(await page.locator(".hero-lib a").getAttribute("href"), LIB);
      for (const width of [1920, 1440, 1180, 1100, 1000, 900, 761, 760, 600, 420, 375, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForTimeout(50);
        const r = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth, nav = document.querySelector(".nav"), bar = document.querySelector(".topbar");
          const onScreen = (e) => { const b = e.getBoundingClientRect(); return b.left >= -0.5 && b.right <= vw + 0.5; };
          const name = document.querySelector(".brand span");
          const mid = (e) => { const b = e.getBoundingClientRect(); return b.top + b.height / 2; };
          return {
            nav: getComputedStyle(nav).display !== "none",
            twoRow: bar.classList.contains("two-row"),
            linksWhole: nav.scrollWidth <= nav.clientWidth + 1 && [...nav.querySelectorAll("a")].every(onScreen),
            // On two rows the strip may scroll; every link must still be reachable inside it.
            linksReachable: [...nav.querySelectorAll("a")].every((a) => a.offsetLeft + a.offsetWidth <= nav.scrollWidth + 1),
            lastLink: nav.lastElementChild.innerText,
            nameCut: name.offsetWidth > 0 && name.scrollWidth > name.clientWidth + 0.5,
            oneLine: Math.abs(mid(document.getElementById("zp-btn")) - mid(document.getElementById("gh-btn"))) < 4,
            controls: ["zp-btn", "theme-btn", "gh-btn"].every((id) => onScreen(document.getElementById(id))) && onScreen(document.querySelector(".tz")),
            sideways: document.documentElement.scrollWidth - vw
          };
        });
        assert.ok(r.nav, `no section links at ${width}px`);
        assert.ok(r.twoRow ? r.linksReachable : r.linksWhole, `a section link is cut off at ${width}px`);
        assert.equal(r.lastLink, "Data & method");
        assert.ok(!r.nameCut, `the name is cut off at ${width}px`);
        assert.ok(r.oneLine, `the controls wrap onto another line at ${width}px`);
        assert.ok(r.controls, `a top-bar control is off screen at ${width}px`);
        assert.equal(r.sideways, 0, `the page scrolls sideways at ${width}px`);
      }
      // Wide enough, everything shares one row with the name in full.
      await page.setViewportSize({ width: 1920, height: 800 });
      await page.waitForTimeout(50);
      if (!zones) assert.ok(!(await page.locator(".topbar").evaluate((b) => b.classList.contains("two-row"))));
      assert.equal(await page.locator(".brand span").innerText(), "Nordic Balancing Watch");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });
}

test("on a phone the menus open on screen and the price board and field list read without sideways scrolling", async () => {
  // One capacity price series in every zone, so its value label is long.
  const everyZone = routeSummary((s) => {
    const base = s.groups.find((g) => g.source === "svk" && g.data === "FCR-N");
    s.groups = s.groups.filter((g) => g !== base).concat(["DK1", "DK2", "FI", "NO1", "NO2", "NO3", "NO4", "NO5", "SE1", "SE2", "SE3", "SE4"]
      .map((zone) => ({ ...structuredClone(base), zone })));
  });
  const { page, errors, close } = await open({ route: everyZone, contextOptions: { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true } });
  try {
    await page.locator("#stats .stat").first().waitFor();
    // No value label on a chart runs past the screen; a long zone list gives way to a count.
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 640 });
      await page.waitForFunction((w) => [...document.querySelectorAll("#lead-chart svg")].every((s) => s.viewBox.baseVal.width <= w), width);
      await page.waitForTimeout(300);
      const labels = await page.locator("text.val-label").evaluateAll((els) => els.map((e) => ({ text: e.textContent, right: e.getBoundingClientRect().right })));
      assert.ok(labels.length > 0);
      for (const l of labels) assert.ok(l.right <= width, `"${l.text}" ends at ${l.right}px on a ${width}px screen`);
      assert.ok(labels.some((l) => l.text === "46 h · 12 zones"), `at ${width}px: ${labels.map((l) => l.text).join(" | ")}`);
    }
    await page.locator('#lead-chart .row-hit[aria-label*="DK1"]').focus();
    assert.match(await page.locator("#tooltip").innerText(), /DK1, DK2, FI, NO1–NO5, SE1–SE4/);
    const fits = (sel) => page.locator(sel).evaluate((e) => {
      const b = e.getBoundingClientRect();
      return b.left >= -0.5 && b.right <= document.documentElement.clientWidth + 0.5;
    });
    await page.locator("#zp-btn").click();
    assert.ok(await fits("#zp-pop"), "zone menu off screen");
    await page.keyboard.press("Escape");
    const cols = page.locator("#zones-table [data-role=cols]");
    await cols.click();
    assert.ok(await fits("#zones-table .dt-pop"), "columns menu off screen");
    await page.keyboard.press("Escape");
    // The board lists each source on its own line, named by the cell, with nothing to scroll.
    const board = page.locator(".board-scroll");
    assert.ok(await board.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
    const labels = await page.locator("#board td[data-label]").evaluateAll((tds) => tds.map((td) => td.getAttribute("data-label")));
    assert.ok(labels.length > 0 && labels.every((l) => ["eSett", "ENTSO-E", "National TSO"].includes(l)), labels.join());
    assert.ok(await page.locator(".table-scroll.dict").evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
    // A count axis never repeats a value.
    const ticks = await page.locator("#size-chart .tick text").allTextContents();
    assert.equal(new Set(ticks).size, ticks.length, ticks.join(" "));
    // The section strip under the controls scrolls to its last link, and following it lands the
    // section heading below the sticky bar, not behind it.
    const last = page.locator(".nav a", { hasText: "Data & method" });
    await last.scrollIntoViewIfNeeded();
    await last.click();
    // Smooth scrolling: wait until the page has moved and come to rest.
    await page.waitForFunction(() => new Promise((done) => {
      const y = window.scrollY;
      setTimeout(() => done(y > 0 && window.scrollY === y), 250);
    }));
    const below = await page.evaluate(() => document.querySelector("#data .section-head h2").getBoundingClientRect().top -
      document.querySelector(".topbar").getBoundingClientRect().bottom);
    assert.ok(below >= 0, `the Data & method heading is ${-below}px behind the top bar`);
    await page.evaluate(() => window.scrollTo(0, 0));
    // The zone panel tells a touch reader to tap, not to hover.
    await page.locator("tr.zd-row").first().click();
    // The zone's data loads after the panel opens; its note is written with the chart.
    await page.locator("#zd-chart .zd-hit").waitFor();
    const note = await page.locator("#zd-note").innerText();
    assert.match(note, /tap an interval/);
    assert.doesNotMatch(note, /hover/i);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// Auction completions are not revisions: the tile counts only revisions and names them,
// and every figure or chart keeps them visible but separate, counting a joint-market
// completion once. The fixture logs one revision once per source: the tile counts the
// revised price once and says how many records that rests on. No source says why it
// changed a price, so the tile says "revised", never "corrected".
test("the headline tile counts each revised price once and names the completions", async () => {
  const { page, errors, close } = await open();
  try {
    await page.locator("#stats .stat").first().waitFor();
    assert.equal(await page.locator("#stats .stat").filter({ hasText: /corrected/i }).count(), 0);
    const tile = page.locator("#stats .stat").filter({ hasText: "Prices revised" });
    assert.equal(await tile.locator(".v").innerText(), "1");
    assert.match(await tile.locator(".s").innerText(), /^3 changes logged across 3 sources · /);
    assert.match(await tile.locator(".s").innerText(), /plus 34 reserve quarter-hours completed by a later auction/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("the chart, the recent list and the log keep completions apart from revisions, a joint market once", async () => {
  const { page, errors, close } = await open();
  try {
    await page.locator("#stats .stat").first().waitFor();
    // The five zone rows of one auction are one strip, counted once in the busiest hour;
    // the TSO strip only counts its one real revision.
    const strips = await page.locator("#hist-chart .strip").count();
    assert.equal(strips, 4);
    const labels = await page.locator("#hist-chart .strip-label").allInnerTexts();
    const tso = labels.find((t) => /National TSO/.test(t));
    const done = labels.filter((t) => /Completed by a later auction/.test(t));
    assert.equal(done.length, 1);
    assert.match(done[0], /most in an hour: 1/);
    assert.match(tso, /most in an hour: 1/);
    // The recent list shows the auction once, with its zones, tagged as a completion.
    assert.equal(await page.locator("#recent .tag.completed").count(), 1);
    assert.match(await page.locator("#recent").innerText(), /Energinet · DK2, SE1–SE4 FCR-N Completed by a later auction/);
    // The log lists revisions only; the completions join on request, tagged.
    const toggle = page.locator("#rev-table .rev-done");
    assert.match(await toggle.innerText(), /Also list completions by a later auction \(1 log entry, shown as 5 zone rows\)/);
    assert.equal(await page.locator("#rev-table .tag.completed").count(), 0);
    assert.equal(await page.locator("#rev-table tbody tr").count(), 3);
    assert.equal(await page.locator("#rev-table [data-role=count]").innerText(), "3 rows");
    await toggle.locator("input").check();
    assert.equal(await page.locator("#rev-table .tag.completed").count(), 5);
    assert.equal(await page.locator("#rev-table tbody tr").count(), 8);
    assert.equal(await page.locator("#rev-table [data-role=count]").innerText(), "8 rows");
    const heads = (await page.locator("#rev-table thead .th-btn").allInnerTexts()).map((h) => h.toLowerCase());
    assert.ok(heads.includes("type"), heads.join(" | "));
    // Unchecked again, the log is the default revision log.
    await toggle.locator("input").uncheck();
    assert.equal(await page.locator("#rev-table tbody tr").count(), 3);
    assert.equal(await page.locator("#rev-table .tag.completed").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("the recent list shows each joint-market completion once and counts the rest the same way", async () => {
  const route = routeRevisions((r) => {
    const extra = r.revisions.filter((x) => x.kind === "completed").map((x) =>
      ({ ...x, interval_start: "2026-10-24T14:00:00Z", revised_at: "2026-10-24T16:30:00Z" }));
    r.revisions = r.revisions.filter((x) => x.revised_at >= "2026-10-24T16:00:00Z").concat(extra)
      .sort((a, b) => (a.revised_at < b.revised_at ? 1 : -1));
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#recent li").first().waitFor();
    // Three revisions and ten zone rows (two auctions of five zones) are five changes, all listed.
    assert.equal(await page.locator("#recent li").count(), 5);
    assert.equal(await page.locator("#recent .tag.completed").count(), 2);
    assert.doesNotMatch(await page.locator("#recent").innerText(), /more in the revision log/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("more than eight recent changes leave a count in the same unit as the rows", async () => {
  const route = routeRevisions((r) => {
    const one = r.revisions.filter((x) => x.kind === "completed");
    const more = Array.from({ length: 9 }, (_, i) => one.map((x) =>
      ({ ...x, interval_start: `2026-10-24T0${i}:00:00Z`, revised_at: "2026-10-24T16:30:00Z" }))).flat();
    r.revisions = r.revisions.filter((x) => x.revised_at >= "2026-10-24T16:00:00Z").concat(more)
      .sort((a, b) => (a.revised_at < b.revised_at ? 1 : -1));
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#recent li").first().waitFor();
    // 3 revisions and 10 auctions (50 zone rows) are 13 changes: 8 listed, 5 more.
    assert.equal(await page.locator("#recent li:not(.more)").count(), 8);
    assert.match(await page.locator("#recent").innerText(), /\+5 more in the revision log/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// A price first seen in the window has had less than the window to change. When the changes
// logged were to older prices, the tile and the share card say how long after publication
// they came, so "0% changed" is not read as "nothing is revised".
test("changes to prices first seen before the window are named with their delay", async () => {
  const route = routeRevisions((r) => {
    r.revisions.filter((x) => x.kind === "changed").forEach((x) => { x.first_published_at = "2026-10-14T18:00:00Z"; });
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#stats .stat").first().waitFor();
    const tile = page.locator("#stats .stat").filter({ hasText: "First prices changed so far" });
    assert.match(await tile.locator(".s").innerText(), / · the 3 changes logged came 10 days after publication$/);
    assert.match(await page.locator("#share-note").innerText(),
      /Logged in the first 3\.5 days of collection: 3 changes to prices first seen before it, 10 days after first publication\. That is longer than this window follows a price\./);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// A zone without procurement does not make a product "not measured"; a price first seen after
// its delivery quarter-hour ended is named; and the lead finding uses only the zones it is about.
test("the reserve callout names late first sightings and only wholly unmeasured products", async () => {
  const route = routeSummary((s) => {
    const mk = (zone, last7) => ({ source: "svk", data: "aFRR up", zone, daily: [],
      last7: { n: 0, excluded: 0, published: 0, revised: 0, revisions: 0, withdrawn: 0, p50: null, p95: null, max: null, revised_share: null, lag_p50_h: null, lag_max_h: null, ...last7 } });
    s.groups = s.groups.concat([
      mk("SE1", { n: 96, published: 96, p50: -456.5, p95: 139.7, max: 166 }),
      mk("SE4", {}),
      { ...mk("SE1", {}), data: "mFRR up" }
    ]).sort((a, b) => [a.source, a.data, a.zone].join("|") < [b.source, b.data, b.zone].join("|") ? -1 : 1);
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#stats .stat").first().waitFor();
    assert.match(await page.locator("#lead-callout").innerText(),
      /Svenska kraftnät aFRR \(SE1\): not always ahead of delivery\. At least 1 in 20 delivery quarter-hours was first seen after it had ended, up to 2\.8 h after\./);
    const pending = await page.locator("#lead-pending").innerText();
    assert.match(pending, /Svenska kraftnät mFRR/);
    assert.doesNotMatch(pending, /Svenska kraftnät aFRR/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// A price first seen this week can still change. Once some closed days are 14 or more days
// old, the headline share and its card follow the prices first seen on those days, whose
// "revised" count the collector keeps current, and leave the newer prices out.
test("the share changed later follows prices watched for 14 days or more", async () => {
  const route = routeSummary((s) => {
    s.collecting_since = "2026-10-01T00:00:00Z";
    const old = (revised) => [
      { day: "2026-10-05", n: 96, p50: 30, p95: 40, published: 96, revised, revisions: 0 },
      { day: "2026-10-06", n: 96, p50: 30, p95: 40, published: 96, revised: 0, revisions: 0 }
    ];
    group(s, "entsoe", "FI").daily.unshift(...old(2));
    group(s, "esett", "DK1").daily.unshift(...old(0));
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#stats .stat").first().waitFor();
    assert.equal(await page.locator("#stats .stat").filter({ hasText: "First prices changed so far" }).count(), 0);
    const tile = page.locator("#stats .stat").filter({ hasText: "First prices changed later" });
    assert.equal(await tile.locator(".v").innerText(), "0.5%");
    assert.equal(await tile.locator(".s").innerText(), "2 of 384 imbalance prices first seen 5–6 Oct, watched 14 days or more");
    assert.match(await page.locator("#share-sub").innerText(),
      /^Prices first seen 5–6 Oct, watched for 14 days or more, that were changed or withdrawn since\. Newer prices are left out because they can still change\.$/);
    assert.match(await page.locator("#share-chart").innerText(), /ENTSO-E · FI/);
    assert.ok((await page.locator("#findings li").allInnerTexts()).includes(
      "Of the 384 first prices seen 5–6 Oct, each watched for 14 days or more, 0.5% (2) were changed later."));
    assert.match(await page.locator("#share-note").innerText(), /^No change to those prices at: eSett \(DK1\)\./);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// Prices that arrive more than 48 hours late are counted, not timed, and reserve lead is
// measured to the start of delivery, once the data file carries those fields.
test("late prices are counted and reserve lead is measured to the start of delivery when the data has them", async () => {
  const route = routeSummary((s) => {
    s.groups.forEach((g) => {
      const l = g.last7;
      if (g.data === "imbalance") { l.late = 0; l.late_max_h = null; return; }
      l.from_start_p50 = l.p50 + 60; l.from_start_p95 = l.p95 + 60; l.seen_after_start = 0;
    });
    Object.assign(group(s, "esett", "DK1").last7, { late: 2, late_max_h: 84.8 });
    const svk = s.groups.find((g) => g.source === "svk" && g.data === "FCR-N");
    Object.assign(svk.last7, { from_start_p50: -540, from_start_p95: 121.5, seen_after_start: 28 });
    const fingrid = s.groups.find((g) => g.source === "fingrid" && g.data === "FCR-D up");
    Object.assign(fingrid.last7, { late: 192, late_max_h: 124.3 });
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#stats .stat").first().waitFor();
    const late = "2 prices first appeared more than 48 hours late, at eSett (DK1), up to 85 h after the interval ended. They are counted, not timed.";
    assert.ok((await page.locator("#findings li").allInnerTexts()).includes(late));
    assert.ok((await page.locator("#delay-callout").innerText()).startsWith(late));
    assert.match(await page.locator("#lead-sub").innerText(), /measured to the start of delivery\./);
    assert.match(await page.locator("#restab-lead").innerText(), /are hours before delivery starts; a negative value means the price was first seen after that\./);
    assert.match(await page.locator("#lead-callout").innerText(),
      /Svenska kraftnät FCR-N \(SE3\): not always ahead of delivery\. 28 of 168 delivery quarter-hours \(17%\) were first seen after delivery had started\./);
    assert.match(await page.locator("#lead-callout").innerText(),
      /Fingrid FCR-D \(FI\): 192 delivery quarter-hours were first priced more than 48 hours after they ended, up to 124 h after\. They are counted, not timed\./);
    // 9.0 h, from the start of delivery, not the 46 h that the quarter-hour ends give.
    assert.match(await page.locator("#lead-chart").getAttribute("aria-label") ?? await page.locator("#lead-chart").innerText(), /Svenska kraftnät[^]*FCR-N[^]*9\.0 h/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// A lead smaller than five minutes is inside the measurement accuracy: the zone is level, and
// no source is counted as first there.
test("two sources within five minutes of each other are level, not first and second", async () => {
  const route = routeSummary((s) => {
    const base = s.groups.filter((g) => g.data === "imbalance");
    const set = (source, zone, p50) => {
      const g = structuredClone(base[0]);
      g.source = source; g.zone = zone; g.last7.p50 = p50; g.last7.max_start = null;
      return g;
    };
    s.groups = s.groups.filter((g) => g.data !== "imbalance").concat([
      set("entsoe", "NO1", 16), set("esett", "NO1", 105),
      set("entsoe", "NO2", 31), set("esett", "NO2", 105),
      set("entsoe", "FI", 45.6), set("fingrid", "FI", 45.4), set("esett", "FI", 90)
    ]).sort((a, b) => ([a.source, a.data, a.zone].join("|") < [b.source, b.data, b.zone].join("|") ? -1 : 1));
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#findings li").first().waitFor();
    const first = (await page.locator("#findings li").allInnerTexts())[0];
    assert.equal(first, "The imbalance price usually shows up first on ENTSO-E: in 2 of 3 price zones, about 16–31 minutes after each 15 minutes end. " +
      "In FI the first two sources are level, within 5 minutes of each other.");
    const tile = page.locator("#stats .stat").filter({ hasText: "First price seen after" });
    assert.equal(await tile.locator(".s").innerText(), "Median zone · ENTSO-E first in 2 of 3 · level in 1");
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// Reserve prices are published per hour and spread over four quarter-hour records, so when
// every reserve count is a multiple of four the page counts hours. Any other count means a
// source changed its resolution, and the page keeps quarter-hours (the fixture's own data).
test("reserve counts are shown per published hour when every count is a multiple of four", async () => {
  const route = routeSummary((s) => {
    s.groups.filter((g) => g.data !== "imbalance").forEach((g) => {
      for (const k of ["n", "revisions", "completions"]) if (typeof g.last7[k] === "number") g.last7[k] *= 4;
    });
    s.completions_7d = { zone_intervals: 4 * s.completions_7d.zone_intervals, market_intervals: 4 * s.completions_7d.market_intervals };
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#stats .stat").first().waitFor();
    const tile = page.locator("#stats .stat").filter({ hasText: "Prices revised" });
    assert.match(await tile.locator(".s").innerText(), /plus 34 hourly reserve prices completed by a later auction/);
    const heads = (await page.locator("#reserve-table thead .th-btn").allInnerTexts()).map((h) => h.toLowerCase());
    assert.ok(heads.includes("hours") && !heads.includes("quarter-hours"), heads.join(" | "));
    assert.match(await page.locator("#restab-note").innerText(), /Counts are in hours, the unit the sources publish reserve prices in\./);
    assert.match(await page.locator("#lead-callout").innerText(), /completed by a later auction in 18 hours in each zone/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("reserve counts stay in quarter-hours when one is not a multiple of four", async () => {
  const { page, errors, close } = await open();
  try {
    await page.locator("#stats .stat").first().waitFor();
    const heads = (await page.locator("#reserve-table thead .th-btn").allInnerTexts()).map((h) => h.toLowerCase());
    assert.ok(heads.includes("quarter-hours"), heads.join(" | "));
    assert.doesNotMatch(await page.locator("#restab-note").innerText(), /Counts are in hours/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// The lead finding is about the zones where that source is first; its delay in a zone where
// another source leads is not part of the range.
test("the lead finding gives the range of the zones where that source is first", async () => {
  const route = routeSummary((s) => {
    const base = s.groups.filter((g) => g.data === "imbalance");
    const set = (source, zone, p50) => {
      const g = structuredClone(base[0]);
      g.source = source; g.zone = zone; g.last7.p50 = p50; g.last7.max_start = null;
      return g;
    };
    s.groups = s.groups.filter((g) => g.data !== "imbalance").concat([
      set("entsoe", "NO1", 16), set("esett", "NO1", 105),
      set("entsoe", "NO2", 31), set("esett", "NO2", 105),
      set("entsoe", "FI", 46), set("fingrid", "FI", 30), set("esett", "FI", 90)
    ]).sort((a, b) => ([a.source, a.data, a.zone].join("|") < [b.source, b.data, b.zone].join("|") ? -1 : 1));
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#findings li").first().waitFor();
    const first = (await page.locator("#findings li").allInnerTexts())[0];
    assert.match(first, /first on ENTSO-E: in 2 of 3 price zones, about 16–31 minutes after each 15 minutes end\./);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// One auction across the joint market's zones is not summed: the findings sentence and the
// reserve call-out say completions per zone — the zone's products summed first — and only
// sum real revisions, labelled as zone sums.
test("the findings and the reserve call-out say completions per zone, revisions as a zone sum", async () => {
  const { page, errors, close } = await open();
  try {
    await page.locator("#stats .stat").first().waitFor();
    const findings = await page.locator("#findings").innerText();
    assert.match(findings, /completed by a later auction in 34 quarter-hours in each zone/);
    assert.match(findings, /10 zone-quarter-hours revised/);
    const callout = await page.locator("#lead-callout").innerText();
    assert.match(callout, /Energinet FCR-D \(DK2, SE1–SE4\): completed by a later auction in 16 quarter-hours in each zone/);
    assert.match(callout, /Energinet FCR-N \(DK2, SE1–SE4\): completed by a later auction in 18 quarter-hours in each zone/);
    assert.match(callout, /10 zone-quarter-hours revised/);
    assert.match(callout, /Fingrid FCR-D \(FI\): re-priced in 4 zone-quarter-hours/);
    assert.doesNotMatch(findings + callout, /170 quarter-hours|180 zone-quarter-hours|170 zone-quarter-hours/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("completions that differ by zone are said as a per-zone range", async () => {
  const route = routeSummary((s) => {
    s.groups.filter((g) => g.source === "energidataservice").forEach((g, i) => { g.last7.completions = 17 + i; });
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#stats .stat").first().waitFor();
    assert.match(await page.locator("#findings").innerText(), /completed by a later auction in 66–78 quarter-hours per zone/);
    const callout = await page.locator("#lead-callout").innerText();
    assert.match(callout, /Energinet FCR-D \(DK2, SE1–SE4\): completed by a later auction in 39–47 quarter-hours per zone/);
    assert.match(callout, /Energinet FCR-N \(DK2, SE1–SE4\): completed by a later auction in 27–31 quarter-hours per zone/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// The reserve finding names the typical lag when it is known; when it is not, the sentence
// runs straight into the auction clause without a comma left behind.
test("the reserve finding names the update lag only when it is known", async () => {
  const { page, errors, close } = await open();
  try {
    await page.locator("#stats .stat").first().waitFor();
    assert.match(await page.locator("#findings").innerText(), /are then updated about 18 h later, when the next auction clears/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
  const route = routeSummary((s) => {
    s.groups.filter((g) => g.data !== "imbalance").forEach((g) => { g.last7.lag_p50_h = null; g.last7.completion_lag_p50_h = null; });
  });
  const noLag = await open({ route });
  try {
    await noLag.page.locator("#stats .stat").first().waitFor();
    const text = await noLag.page.locator("#findings").innerText() + await noLag.page.locator("#lead-callout").innerText();
    assert.match(text, /are then updated when the next auction clears/);
    assert.doesNotMatch(text, /updated,\s*when/);
    assert.deepEqual(noLag.errors, []);
  } finally {
    await noLag.close();
  }
});

test("the findings and the call-out name the completion lag, not the revision lag", async () => {
  const { page, errors, close } = await open();
  try {
    await page.locator("#stats .stat").first().waitFor();
    assert.match(await page.locator("#findings").innerText(), /are then updated about 18 h later, when the next auction clears/);
    const callout = await page.locator("#lead-callout").innerText();
    assert.match(callout, /Energinet FCR-N \(DK2, SE1–SE4\): completed by a later auction in 18 quarter-hours in each zone, typically 18 h after first publication; 10 zone-quarter-hours revised/);
    assert.doesNotMatch(callout, /6\.0 h/);
    assert.match(callout, /Fingrid FCR-D \(FI\): re-priced in 4 zone-quarter-hours, typically 8\.7 h after first publication/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

// Data files from a collector that counts completions but not yet their lag look like live
// data does today: the update lag is simply unknown, and the table keeps its old columns.
test("data without the completion lag renders with no timing", async () => {
  const route = routeSummary((s) => {
    s.groups.forEach((g) => { delete g.last7.completion_lag_p50_h; delete g.last7.completion_lag_max_h; });
  });
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#stats .stat").first().waitFor();
    assert.match(await page.locator("#findings").innerText(), /are then updated when the next auction clears/);
    for (const line of (await page.locator("#lead-callout").innerText()).split("\n").filter((l) => l.startsWith("Energinet"))) {
      assert.doesNotMatch(line, /typically/, line);
    }
    const heads = (await page.locator("#reserve-table thead .th-btn").allInnerTexts()).map((h) => h.toLowerCase());
    assert.ok(heads.includes("typically after"), heads.join(" | "));
    assert.ok(!heads.includes("revised after") && !heads.includes("completed after"), heads.join(" | "));
    // The column counts delivery quarter-hours, so the note names that unit (it said "prices").
    assert.equal(await page.locator("#restab-note").innerText(),
      "“Revised” counts every change recorded in the first 3.5 days of collection, including changes to delivery quarter-hours from before it; “Completed later” counts the quarter-hours whose price a later auction completed, which are not revisions.");
    assert.equal(await page.locator("#restab-lead").innerText(),
      "“Median lead” and “95% at least” are hours before each delivery quarter-hour ends; a negative value means the price was first seen after that.");
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("the reserve table separates revisions from prices a later auction completed", async () => {
  const { page, errors, close } = await open();
  try {
    await page.locator("#stats .stat").first().waitFor();
    const heads = (await page.locator("#reserve-table thead .th-btn").allInnerTexts()).map((h) => h.toLowerCase());
    assert.ok(heads.includes("revised") && heads.includes("completed later"), heads.join(" | "));
    assert.ok(heads.includes("revised after") && heads.includes("completed after"), heads.join(" | "));
    assert.ok(!heads.includes("typically after"), heads.join(" | "));
    assert.ok(heads.includes("quarter-hours"), heads.join(" | "));
    assert.ok(!heads.includes("price changes") && !heads.includes("hours"), heads.join(" | "));
    assert.match(await page.locator("#restab-note").innerText(), /“Revised” counts every change.+“Completed later”/);
    assert.match(await page.locator("#restab-note").innerText(), /median hours from first publication/);
    const enRow = page.locator("#reserve-table tbody tr").filter({ hasText: "Energinet" }).filter({ hasText: "FCR-N" }).first();
    assert.equal(await enRow.locator("td").nth(6).innerText(), "2");
    assert.equal(await enRow.locator("td").nth(7).innerText(), "18");
    assert.equal(await enRow.locator("td").nth(8).innerText(), "6.0 h");
    assert.equal(await enRow.locator("td").nth(9).innerText(), "18 h");
    const edRow = page.locator("#reserve-table tbody tr").filter({ hasText: "Energinet" }).filter({ hasText: "FCR-D" }).first();
    assert.equal(await edRow.locator("td").nth(8).innerText(), "—");
    assert.equal(await edRow.locator("td").nth(9).innerText(), "18 h");
    const fiRow = page.locator("#reserve-table tbody tr").filter({ hasText: "Fingrid" });
    assert.equal(await fiRow.locator("td").nth(6).innerText(), "4");
    assert.equal(await fiRow.locator("td").nth(7).innerText(), "—");
    assert.equal(await fiRow.locator("td").nth(9).innerText(), "—");
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("data without the completion fields renders exactly as before", async () => {
  const route = {
    match: "**/data/*.json",
    handle: (r) => {
      const name = r.request().url().split("/").pop();
      const body = name === "revisions.json"
        ? (() => { const rev = structuredClone(REVISIONS); rev.revisions = rev.revisions.filter((x) => x.kind !== "completed"); return rev; })()
        : (() => {
          const s = structuredClone(SUMMARY);
          delete s.completions_7d;
          s.groups.forEach((g) => {
            delete g.last7.completions; delete g.last7.completion_lag_p50_h; delete g.last7.completion_lag_max_h;
            (g.daily || []).forEach((d) => delete d.completions);
          });
          return s;
        })();
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
  };
  const { page, errors, close } = await open({ route });
  try {
    await page.locator("#stats .stat").first().waitFor();
    assert.doesNotMatch(await page.locator("#stats").innerText(), /completed by a later auction/i);
    assert.equal(await page.locator("#hist-chart .strip").count(), 3);
    assert.equal(await page.locator("#recent .tag.completed").count(), 0);
    assert.equal(await page.locator("#rev-table .rev-done").count(), 0);
    assert.equal(await page.locator("#rev-table .tag.completed").count(), 0);
    assert.equal(await page.locator("#rev-table tbody tr").count(), 3);
    const heads = (await page.locator("#reserve-table thead .th-btn").allInnerTexts()).map((h) => h.toLowerCase());
    assert.ok(heads.includes("price changes") && !heads.includes("revised") && !heads.includes("completed later"), heads.join(" | "));
    assert.ok(heads.includes("typically after") && !heads.includes("revised after") && !heads.includes("completed after"), heads.join(" | "));
    assert.equal(await page.locator("#restab-note").innerText(),
      "“Price changes” counts every change recorded in the first 3.5 days of collection, including changes to delivery quarter-hours from before it.");
    assert.match(await page.locator("#findings").innerText(), /14 zone-quarter-hours re-priced/);
    assert.doesNotMatch(await page.locator("#lead-callout").innerText(), /completed|in each zone/i);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("the development journal records the auction-completion finding", async () => {
  const { page, errors, close } = await openPage(browser, `${origin}/journal.html`);
  try {
    const text = await page.locator("main").innerText();
    assert.match(text, /9 November 2026: Energinet’s FCR price is a running total until the last auction/);
    assert.match(text, /completed 453 hourly FCR prices of the joint market, against 9 revisions/);
    assert.match(text, /63 prices can show as 315 changes/);
    assert.doesNotMatch(text, /period affected|what was wrong|figures were corrected/i);
    assert.match(text, /never edited or deleted/i);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("crawler files and unknown addresses are served as expected", async () => {
  const { page, close } = await open({ javaScriptEnabled: false });
  try {
    for (const [path, type] of [["/robots.txt", "text/plain"], ["/sitemap.xml", "application/xml"], ["/favicon.svg", "image/svg+xml"]]) {
      const res = await page.request.get(`${origin}${path}`);
      assert.equal(res.status(), 200, path);
      assert.equal(res.headers()["content-type"], type);
    }
    for (const path of ["/data//etc/passwd", "//etc/passwd", "/..%2f..%2fREADME.md", "/data/%2e%2e%2f%2e%2e%2fREADME.md"]) {
      assert.equal((await page.request.get(`${origin}${path}`)).status(), 404, path);
    }
    const res = await page.goto(`${origin}/no-such-page`);
    assert.equal(res.status(), 404);
    assert.equal(await page.locator('meta[name="robots"]').getAttribute("content"), "noindex");
    assert.ok(await page.getByRole("link", { name: "Go to the home page" }).isVisible());
  } finally {
    await close();
  }
});
