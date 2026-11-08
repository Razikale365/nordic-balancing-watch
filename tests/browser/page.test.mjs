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
  test(`the share of first prices changed later when ${label}`, async () => {
    const handle = (r) => r.fulfill({ status: 200, contentType: "application/json", body: summaryWith(published, revised) });
    const { page, errors, close } = await open({ route: { match: "**/data/summary.json", handle } });
    try {
      await page.locator("#stats .stat").first().waitFor();
      const tile = page.locator("#stats .stat").filter({ hasText: "First prices changed later" });
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
    assert.match(found[0], /after it ended at the sources that share it: eSett \(DK1, DK2\) and ENTSO-E \(FI\), so the delay began before publication/);
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
  const { page, errors, close } = await open({ contextOptions: { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true } });
  try {
    await page.locator("#stats .stat").first().waitFor();
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
