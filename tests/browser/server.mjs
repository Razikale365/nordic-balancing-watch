// A local stand-in for Cloudflare Pages for the browser tests: serves site/ with the headers
// from site/_headers (so the pages run under the real Content-Security-Policy), /data/* from
// the fixtures, and 404.html for anything unknown.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseHeaders } from "../headers.mjs";

const SITE = new URL("../../site/", import.meta.url);
const FIXTURES = new URL("../fixtures/data/", import.meta.url);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".txt": "text/plain", ".xml": "application/xml" };
const RULES = parseHeaders(readFileSync(new URL("_headers", SITE), "utf8"));

// Headers for a static file; /data/* stands in for a Pages Function, which _headers skips.
function staticHeaders(path) {
  if (path.startsWith("/data/")) return {};
  const out = {};
  for (const rule of RULES) {
    const match = rule.path.endsWith("*") ? path.startsWith(rule.path.slice(0, -1)) : path === rule.path;
    if (match) Object.assign(out, rule.headers);
  }
  return out;
}

export async function startServer() {
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
      res.writeHead(200, { ...staticHeaders(path), "content-type": TYPES[extname(file.pathname)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { ...staticHeaders(path), "content-type": TYPES[".html"] });
      res.end(await readFile(new URL("404.html", SITE)));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// Opens a page and collects uncaught script errors and Content-Security-Policy violations;
// close() fails the test if the policy blocked anything the page tried to do.
export async function openPage(browser, url, { javaScriptEnabled = true, route, contextOptions } = {}) {
  const context = await browser.newContext({ javaScriptEnabled, ...contextOptions });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], violations = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  if (route) await page.route(route.match, route.handle);
  await page.goto(url, { waitUntil: "load" });
  return {
    page, errors, context,
    close: async () => {
      await context.close();
      if (violations.length) throw new Error("blocked by the Content-Security-Policy:\n" + violations.join("\n"));
    }
  };
}
