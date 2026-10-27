// Checks on the HTML exactly as served, before any JavaScript runs: what a crawler that does
// not render scripts, or a reader whose scripts or data fail, gets from the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SITE = "https://nordic-balancing-watch.pages.dev/";
const read = (path) => readFileSync(new URL(`../site/${path}`, import.meta.url), "utf8");
const index = read("index.html");
const notFound = read("404.html");

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

// A small tag walker: enough for this hand-written page to tell, for every element, whether
// it or an ancestor carries the `hidden` attribute, and what text it contains.
function parse(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const root = { tag: "#root", attrs: "", children: [], text: "", parent: null };
  let cur = root;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      for (let n = cur; n; n = n.parent) n.text += m[4];
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      let n = cur;
      while (n !== root && n.tag !== tag) n = n.parent;
      assert.notEqual(n, root, `unmatched </${tag}>`);
      cur = n.parent;
    } else if (tag !== "!doctype") {
      const el = { tag, attrs: m[3], children: [], text: "", parent: cur };
      cur.children.push(el);
      if (!VOID.has(tag) && !m[3].trim().endsWith("/")) cur = el;
    }
  }
  assert.equal(cur, root, `unclosed <${cur.tag}>`);
  return root;
}

function all(node, pred, out = []) {
  for (const c of node.children) {
    if (pred(c)) out.push(c);
    all(c, pred, out);
  }
  return out;
}
const attr = (el, name) => {
  const m = el.attrs.match(new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*"([^"]*)")?(?=\\s|$|/)`));
  return m ? (m[1] ?? "") : null;
};
const hasAttr = (el, name) => attr(el, name) !== null;
const byId = (doc, id) => all(doc, (e) => attr(e, "id") === id)[0];
function shown(el) {
  for (let n = el; n; n = n.parent) {
    if (hasAttr(n, "hidden") || n.tag === "noscript" || n.tag === "template") return false;
  }
  return true;
}
const words = (s) => s.replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
function meta(html, key, value) {
  const re = new RegExp(`<meta\\s+${key}="${value}"\\s+content="([^"]*)"`, "g");
  return [...html.matchAll(re)].map((m) => m[1]);
}

const doc = parse(index);

test("the head has a title, description and one canonical address", () => {
  const title = index.match(/<title>([^<]*)<\/title>/)[1];
  assert.ok(title.length >= 20 && title.length <= 75, `title length ${title.length}`);
  const [description] = meta(index, "name", "description");
  assert.ok(description.length >= 70 && description.length <= 160, `description length ${description.length}`);
  const canonical = [...index.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map((m) => m[1]);
  assert.deepEqual(canonical, [SITE]);
  assert.equal(meta(index, "name", "robots").length, 0, "the home page must not carry a robots meta tag");
});

test("social metadata matches the page", () => {
  const og = (p) => meta(index, "property", `og:${p}`);
  assert.deepEqual(og("url"), [SITE]);
  assert.deepEqual(og("type"), ["website"]);
  assert.deepEqual(og("site_name"), ["Nordic Balancing Watch"]);
  assert.deepEqual(og("description"), meta(index, "name", "description"));
  const h1 = all(doc, (e) => e.tag === "h1")[0];
  assert.equal(og("title")[0], words(h1.text));
  assert.deepEqual(meta(index, "name", "twitter:card"), ["summary"]);
  // Only claim an image once there is one to show.
  assert.equal(og("image").length, 0);
});

test("the public address is the same everywhere it is written", () => {
  const config = read("config.js").match(/siteUrl:\s*"([^"]*)"/)[1];
  assert.equal(config, SITE);
  assert.match(read("robots.txt"), new RegExp(`^Sitemap: ${SITE}sitemap\\.xml$`, "m"));
  const locs = [...read("sitemap.xml").matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, [SITE]);
  assert.ok(byId(doc, "cite-text").text.trim().endsWith(SITE));
});

test("robots.txt lets crawlers fetch the page and its data", () => {
  const robots = read("robots.txt");
  const disallowed = [...robots.matchAll(/^Disallow:\s*(\S*)/gm)].map((m) => m[1]);
  assert.deepEqual(disallowed, ["/api/"]);
  assert.match(read("sitemap.xml"), /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
});

test("the structured data describes the dataset and links the files the page offers", () => {
  const blocks = [...index.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1);
  const data = JSON.parse(blocks[0][1]);
  assert.equal(data["@context"], "https://schema.org");
  assert.equal(data["@type"], "Dataset");
  assert.equal(data.url, SITE);
  assert.ok(data.description.length >= 50 && data.description.length <= 5000);
  assert.match(data.temporalCoverage, /^\d{4}-\d{2}-\d{2}\/\.\.$/);
  const downloads = all(doc, (e) => e.tag === "a" && hasAttr(e, "download")).map((a) => attr(a, "href"));
  assert.deepEqual(
    data.distribution.map((d) => d.contentUrl),
    downloads.map((href) => new URL(href, SITE).href)
  );
});

test("the heading and explanations are in the HTML and not hidden", () => {
  const h1 = all(doc, (e) => e.tag === "h1");
  assert.equal(h1.length, 1);
  assert.ok(shown(h1[0]));
  assert.match(words(h1[0].text), /Nordic balancing prices/);
  for (const sel of ["lede", "explain", "method"]) {
    const el = all(doc, (e) => (attr(e, "class") || "").split(" ").includes(sel))[0];
    assert.ok(el && shown(el), `.${sel} is hidden`);
    assert.ok(words(el.text).length > 150, `.${sel} has little text`);
  }
});

test("every section the navigation links to is visible and introduced in text", () => {
  const nav = all(doc, (e) => e.tag === "nav")[0];
  const targets = all(nav, (e) => e.tag === "a").map((a) => attr(a, "href"));
  assert.ok(targets.length >= 5);
  for (const href of targets) {
    assert.match(href, /^#/);
    const section = byId(doc, href.slice(1));
    assert.ok(section, `${href} does not exist`);
    assert.ok(shown(section), `${href} is hidden`);
    const h2 = all(section, (e) => e.tag === "h2")[0];
    assert.ok(h2 && shown(h2), `${href} has no visible heading`);
  }
  for (const a of all(doc, (e) => e.tag === "a" && /^#./.test(attr(e, "href") || ""))) {
    assert.ok(byId(doc, attr(a, "href").slice(1)), `${attr(a, "href")} does not exist`);
  }
});

test("only blocks that need data are hidden until it loads", () => {
  for (const el of all(doc, (e) => hasAttr(e, "hidden"))) {
    const id = attr(el, "id");
    const known = hasAttr(el, "data-needs-data") ||
      ["stale-banner", "empty-state", "trend", "zp-pop", "cite-copy"].includes(id);
    assert.ok(known, `unexpected hidden <${el.tag} ${el.attrs.trim()}>`);
    if (hasAttr(el, "data-needs-data")) {
      // Text a crawler should see must not live inside a block that waits for data.
      assert.equal(all(el, (e) => e.tag === "p" && !hasAttr(e, "id") && words(e.text).length > 40 &&
        !/sub|note|howto|callout/.test(attr(e, "class") || "")).length, 0);
    }
  }
});

test("the glossary is written in the page and covers every term the page uses", () => {
  const entries = all(byId(doc, "glossary"), (e) => e.tag === "div" && /^g-/.test(attr(e, "id") || ""));
  assert.ok(entries.length >= 15);
  for (const e of entries) {
    assert.ok(shown(e));
    assert.equal(all(e, (c) => c.tag === "dt").length, 1);
    assert.ok(words(all(e, (c) => c.tag === "dd")[0].text).length > 20);
  }
  const keys = new Set(entries.map((e) => attr(e, "id").slice(2)));
  const app = read("app.js");
  const used = new Set([
    ...[...index.matchAll(/data-term="([^"]+)"/g)].map((m) => m[1]),
    ...[...app.matchAll(/\bterm\("([^"]+)"/g)].map((m) => m[1])
  ]);
  for (const k of used) assert.ok(keys.has(k), `term "${k}" has no glossary entry`);
});

test("without JavaScript the page says what is missing and where the data is", () => {
  const ns = all(doc, (e) => e.tag === "noscript");
  assert.equal(ns.length, 1);
  assert.match(words(ns[0].text), /need JavaScript/);
  const links = all(ns[0], (e) => e.tag === "a").map((a) => attr(a, "href"));
  assert.deepEqual(links, ["/data/summary.json", "/data/revisions.json"]);
});

test("the 404 page is not indexed and links home", () => {
  assert.deepEqual(meta(notFound, "name", "robots"), ["noindex"]);
  assert.doesNotMatch(notFound, /rel="canonical"/);
  assert.match(notFound, /<a [^>]*href="\/"/);
});

test("both pages use the favicon file", () => {
  assert.match(read("favicon.svg"), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  for (const html of [index, notFound]) assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
});
