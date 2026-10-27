// The security headers in site/_headers must match the pages they protect: a CSP that blocks
// the page's own inline script would break the theme, and one that allows more than the page
// needs protects less.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseHeaders } from "./headers.mjs";

const read = (path) => readFileSync(new URL(`../site/${path}`, import.meta.url), "utf8");
const PAGES = ["index.html", "404.html"];

const rules = parseHeaders(read("_headers"));
const all = rules.find((r) => r.path === "/*").headers;
const csp = Object.fromEntries(all["content-security-policy"].split(";").map((d) => {
  const [name, ...values] = d.trim().split(/\s+/);
  return [name, values];
}));

test("one rule covers every static page", () => {
  assert.deepEqual(rules.map((r) => r.path), ["/*"]);
});

test("the policy denies by default and allows no inline or evaluated script", () => {
  assert.deepEqual(csp["default-src"], ["'none'"]);
  assert.deepEqual(csp["base-uri"], ["'none'"]);
  assert.deepEqual(csp["frame-ancestors"], ["'none'"]);
  assert.deepEqual(csp["form-action"], ["'self'"]);
  assert.deepEqual(csp["connect-src"], ["'self'"]);
  assert.deepEqual(csp["img-src"], ["'self'"]);
  assert.equal(csp["script-src"][0], "'self'");
  for (const v of csp["script-src"].slice(1)) assert.match(v, /^'sha256-[A-Za-z0-9+/]+=*'$/);
  assert.ok(!csp["script-src"].some((v) => /unsafe|\*|https?:|data:|blob:/.test(v)));
});

test("every inline script on the pages is allowed by its hash, and nothing else is", () => {
  const hashes = new Set();
  for (const page of PAGES) {
    const html = read(page);
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/type="application\/ld\+json"/.test(m[1])) continue; // data, never executed
      hashes.add(`'sha256-${createHash("sha256").update(m[2]).digest("base64")}'`);
    }
  }
  assert.deepEqual(new Set(csp["script-src"].slice(1)), hashes);
});

test("the pages load scripts and styles only from the site and use no inline handlers", () => {
  for (const page of [...PAGES, "app.js"]) {
    const text = read(page);
    assert.doesNotMatch(text, /<[a-z][^>]*\son[a-z]+\s*=/i, `${page}: inline event handler`);
    assert.doesNotMatch(text, /javascript:/i, `${page}: javascript: URL`);
    for (const m of text.matchAll(/<script\b[^>]*\bsrc="([^"]*)"|<link rel="(?:stylesheet|icon)" href="([^"]*)"/g)) {
      m[1] ??= m[2];
      assert.ok(!/^(https?:)?\/\//.test(m[1]), `${page}: loads ${m[1]} from another site`);
    }
  }
  assert.doesNotMatch(read("app.js"), /\beval\(|new Function\(|set(?:Timeout|Interval)\(\s*["'`]/);
});

test("the other security headers are set", () => {
  assert.equal(all["x-content-type-options"], "nosniff");
  assert.equal(all["x-frame-options"], "DENY");
  assert.equal(all["referrer-policy"], "strict-origin-when-cross-origin");
  assert.equal(all["cross-origin-opener-policy"], "same-origin");
  assert.match(all["permissions-policy"], /camera=\(\)/);
  assert.match(all["strict-transport-security"], /^max-age=\d{7,}$/);
});
