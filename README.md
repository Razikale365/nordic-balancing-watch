# Nordic Balancing Watch

A small static site that shows when Nordic balancing prices first become available and how
they change afterwards. Nordic price APIs only expose the current value — when a
price is revised, the earlier value is gone — so a collector polls the sources and keeps every
version it sees.

Live site: https://nordic-balancing-watch.pages.dev/

Collection started on 24 October 2026, so the history is still short and the findings are
early observations from that sample, not established market patterns. In the first days the
same imbalance price usually appeared on one source well before another, and some first values
were replaced later. The site computes every figure from the current data and states how much
history it rests on.

## What the site shows

- Headline figures and a short list of findings, computed from the current data, with the
  amount of collected history they are based on.
- Imbalance prices: minutes from the end of each interval until the first price appears, per
  zone and source (median and 95th percentile), the share of first prices changed later, and
  what those changes were.
- Reserve capacity: how many hours before delivery each product's price appears, and how often
  it is re-priced.
- Revision log: an hourly timeline and a table of the most recent recorded price changes (the
  data file keeps the newest 500).
- Every table can be searched, filtered, sorted, reordered, trimmed to chosen columns and
  downloaded as CSV. Times can be shown in UTC or Nordic time.
- A waitlist form ("get revision alerts and API access") backed by a Cloudflare D1 table
  through one Pages Function. No tracking, no cookies, no accounts.

The page is plain HTML, CSS and JavaScript with inline SVG charts: no build step and no
third-party scripts.

## How the data gets there

A separate collector (built on the open-source
[`nordic-balancing`](https://pypi.org/project/nordic-balancing/) library,
[source on GitHub](https://github.com/Razikale365/nordic-balancing)) polls imbalance prices
every 15 minutes and reserve capacity prices hourly. It writes `summary.json` and
`revisions.json` — the format is the schema-1 contract validated by
`scripts/check_data.py` — and pushes them hourly to the `data` branch of this repository.
The site reads them through a small Pages Function (`functions/data/[name].js`) that fetches
the two files from that branch, rejects anything that is not schema-1 JSON, and caches them
at the edge for five minutes. New data therefore needs no redeploy; the deploy workflow runs
only when the site's code changes.

## Data sources and licences

- [eSett](https://www.esett.com/) — see the provider's terms
- [Energinet Energi Data Service](https://www.energidataservice.dk/) — CC BY 4.0
- [Fingrid open data](https://data.fingrid.fi/) — CC BY 4.0
- [ENTSO-E Transparency Platform](https://transparency.entsoe.eu/) — see the provider's terms
- [Svenska kraftnät (Mimer)](https://mimer.svk.se/) — see the provider's terms

The site is not affiliated with any of these organisations. The price data belongs to its
providers under their licences; the code in this repository is MIT-licensed (see LICENSE).

## Run locally

The site is plain HTML/CSS/JS with no build step. For data, copy the bundled fixture into
place (or point a real data directory at `site/data`):

```
copy tests\fixtures\data site\data        # Windows
cp -r tests/fixtures/data site/data       # macOS/Linux
```

Then either serve it with Wrangler (this also runs the `/api/waitlist` Pages Function):

```
npx wrangler pages dev site
```

or with any static file server — the waitlist form will not work, everything else will:

```
python -m http.server -d site
```

## Tests

```
python -m pytest -q                        # check_data.py contract tests
node --test tests/*.test.mjs               # functions, page metadata and security header tests
node --test tests/browser/*.test.mjs       # the page in Chromium (needs Playwright)
python scripts/check_data.py tests/fixtures/data
```

The browser tests check that the heading, explanations, method and glossary stay readable
with JavaScript off, when `app.js` fails to load and when the data files cannot be fetched,
and that the figures appear when they can. They serve the pages with the headers from
`site/_headers`, fail on any Content-Security-Policy violation, and check that markup in the
data files is never run and that CSV downloads cannot carry spreadsheet formulas. Install Playwright for them with
`npm install --no-save playwright && npx playwright install chromium`.

## Search engines

The explanatory text, method and glossary are in the HTML itself; only the figures, charts
and tables wait for the data. `site/robots.txt` and `site/sitemap.xml` point crawlers at the
page, the head carries a canonical link, Open Graph tags and schema.org `Dataset` data, and
`/data/*.json` responses send `X-Robots-Tag: noindex` so crawlers can fetch them to render the
page without listing them as results. The public address is written in `index.html` (canonical,
`og:url`, JSON-LD, citation), `config.js`, `robots.txt` and `sitemap.xml`;
`tests/seo.test.mjs` fails if they disagree, so change them together when the site moves to its
final domain.

## Security

- `site/_headers` sends a strict Content-Security-Policy with every page (scripts only from
  the site plus one hashed inline script, no third-party anything, no framing) and the usual
  hardening headers. If you change the inline theme script in `index.html` and `404.html`,
  update its hash there; `tests/security.test.mjs` fails until it matches.
- Cloudflare does not apply `_headers` to Pages Functions, so `/data/*` and `/api/waitlist`
  set their own `nosniff` and CSP headers.
- The waitlist accepts only same-origin JSON bodies of at most 2 KB, validates both fields
  and stores them with bound SQL parameters. Its response does not reveal whether an
  address was already on the list.
- Everything from the data files is escaped before it reaches the page, and prices that are
  not numbers are shown as a dash.
- The workflows pin every action to a commit SHA, do not keep the git token after checkout,
  and pass the Cloudflare token only to the two steps that need it.

## One-time setup

1. Create a Cloudflare Pages project named `nordic-balancing-watch` connected to this repo
   (or let the first `wrangler pages deploy` create it).
2. Create the D1 database `nbw-waitlist` (`wrangler d1 create nbw-waitlist`) and paste the
   printed id into `database_id` in `wrangler.toml`. The deploy workflow applies
   `migrations/` remotely on every run.
   Do this before step 3: the migrations step fails while the placeholder id is in place.
3. Add two repository secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
   Without them the workflow still runs the tests but skips the deploy step.
4. Give the collector a deploy key with write access so it can push `summary.json` and
   `revisions.json` to the `data` branch every hour.
5. Add a Cloudflare rate-limiting rule for `/api/waitlist` (for example 5 requests per minute
   per IP); the function itself does not rate-limit.
