// The page in a real browser: the explanations must stay readable when JavaScript is off, when
// the script fails to load and when the data files cannot be fetched; with data, everything shows.
// Needs Playwright with Chromium: node --test tests/browser/*.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname } from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");

const SITE = new URL("../../site/", import.meta.url);
const FIXTURES = new URL("../fixtures/data/", import.meta.url);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".txt": "text/plain", ".xml": "application/xml" };

// Serves site/ like Pages does: / is index.html, /data/* comes from the fixtures, anything
// unknown gets 404.html.
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const [base, rel] = path === "/" ? [SITE, "index.html"]
    : path.startsWith("/data/") ? [FIXTURES, path.slice(6)]
    : [SITE, path.slice(1)];
  const file = new URL(rel, base);
  try {
    // Serve nothing outside the folder: "/data//etc/passwd" would otherwise resolve to /etc/passwd.
    if (!file.href.startsWith(base.href)) throw new Error("outside the served folder");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file.pathname)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": TYPES[".html"] });
    res.end(await readFile(new URL("404.html", SITE)));
  }
});

let browser, origin;
before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server.close();
});

// Opens the home page; `route` can fail requests. Collects uncaught script errors.
async function open({ javaScriptEnabled = true, route } = {}) {
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (route) await page.route(route.match, route.handle);
  await page.goto(`${origin}/`, { waitUntil: "load" });
  return { page, errors, close: () => context.close() };
}

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
    // Terms added by the script get their definitions from the glossary in the page too.
    const dynamic = page.locator('#findings .term, #stats .term, #board-note .term, #lead-pending .term').first();
    if (await dynamic.count()) assert.match(await dynamic.getAttribute("aria-label"), /: \S/);
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
