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

test("every section link reads in full and the top bar stays on screen at any width", async () => {
  const { page, errors, close } = await open();
  try {
    await page.locator("#stats .stat").first().waitFor();
    const LIB = "https://github.com/Razikale365/nordic-balancing";
    assert.equal(await page.locator("#gh-btn").getAttribute("href"), LIB);
    assert.equal(await page.locator(".hero-lib a").getAttribute("href"), LIB);
    for (const width of [1440, 1180, 1100, 1000, 900, 761, 760, 420, 375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const r = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth, nav = document.querySelector(".nav");
        const onScreen = (e) => { const b = e.getBoundingClientRect(); return b.left >= -0.5 && b.right <= vw + 0.5; };
        return {
          nav: getComputedStyle(nav).display !== "none",
          linksWhole: nav.scrollWidth <= nav.clientWidth + 1 && [...nav.querySelectorAll("a")].every(onScreen),
          lastLink: nav.lastElementChild.innerText,
          controls: ["zp-btn", "theme-btn", "gh-btn"].every((id) => onScreen(document.getElementById(id))) && onScreen(document.querySelector(".tz")),
          sideways: document.documentElement.scrollWidth - vw
        };
      });
      assert.equal(r.nav, width > 760, `nav at ${width}px`);
      if (r.nav) {
        assert.ok(r.linksWhole, `a section link is cut off at ${width}px`);
        assert.equal(r.lastLink, "Data & method");
      }
      assert.ok(r.controls, `a top-bar control is off screen at ${width}px`);
      assert.equal(r.sideways, 0, `the page scrolls sideways at ${width}px`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

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
    // The zone panel tells a touch reader to tap, not to hover.
    await page.locator("tr.zd-row").first().click();
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
