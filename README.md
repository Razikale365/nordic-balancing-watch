# Nordic Balancing Watch

A small static site that shows when Nordic balancing prices are first published and how
often they are revised afterwards. Nordic price APIs only expose the current value — when a
price is revised, the earlier value is gone — so a collector polls the sources and keeps every
version it sees.

Live site: _URL to be added once the Cloudflare Pages project exists._

One observation from the first days of data: ENTSO-E has the first imbalance price in most
Nordic zones, 15-45 minutes after the interval ends, while eSett publishes the same prices 20-80
minutes later. For Denmark and Finland eSett often first publishes 0.00 and replaces it with the
real price one to two hours later.

## What the site shows

- Headline figures and a short list of findings, computed from the current data.
- Imbalance prices: minutes from the end of each interval until the first price appears, per
  zone and source (median and 95th percentile), the share of first prices changed later, and
  what those changes were.
- Reserve capacity: how many hours before delivery each product's price appears, and how often
  it is re-priced.
- Revision log: an hourly timeline and a table of every recorded price change.
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
node --test tests/*.test.mjs               # waitlist and data function tests
python scripts/check_data.py tests/fixtures/data
```

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
