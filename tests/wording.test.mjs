// Wording checks on the files as served. No source says why it changed a price, so the
// page describes a provider's change as a revision and never as a correction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../site/${path}`, import.meta.url), "utf8");
const script = read("app.js").replace(/\/\*[\s\S]*?\*\//g, "");
const page = read("index.html").replace(/<!--[\s\S]*?-->/g, "");

test("the script never calls a provider's price change a correction", () => {
  assert.doesNotMatch(script, /correct/i);
});

test("the page never calls a provider's price change a correction", () => {
  assert.doesNotMatch(page, /correct/i);
});

test("the glossary and the structured data define a revision as the method does", () => {
  const glossary = page.match(/<div id="g-revision">[\s\S]*?<dd>([\s\S]*?)<\/dd>/)[1];
  const data = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  for (const text of [glossary, data.measurementTechnique]) {
    assert.match(text, /later auction/);
    assert.match(text, /currency recalculation/);
    assert.match(text, /0\.00 placeholder/);
    assert.match(text, /no reason/);
    assert.doesNotMatch(text, /\bany (later )?change\b/i);
  }
});
