#!/usr/bin/env python3
"""Check that the live site's data files are valid and fresh.

Usage: check_live.py [base URL]
The base URL defaults to $NBW_BASE_URL, then https://nordic-balancing-watch.pages.dev.
Downloads summary.json, revisions.json and the 12 zone files, validates them with
check_data.py, and exits 1 with one line per problem when:
  - generated_at is more than 45 minutes old;
  - more than 10% of the collector's checks in the last 24 hours failed;
  - the newest price of a source and zone was already more than that series' 95th percentile
    plus 2 hours late when the summary was generated.
Stdlib only.
"""
import json
import os
import sys
import tempfile
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_data  # noqa: E402

DEFAULT_BASE = "https://nordic-balancing-watch.pages.dev"
ZONES = ["DK1", "DK2", "FI", "NO1", "NO2", "NO3", "NO4", "NO5", "SE1", "SE2", "SE3", "SE4"]
FILES = ["summary.json", "revisions.json"] + [f"zone-{z}.json" for z in ZONES]
MAX_AGE = timedelta(minutes=45)
MAX_ERROR_SHARE = 0.10
LATE_SLACK_MIN = 120


def parse_ts(value):
    """An ISO timestamp ending in Z as an aware datetime, or None."""
    if not check_data.is_ts(value):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def age_problem(summary, now):
    generated = parse_ts(summary.get("generated_at"))
    if generated is None:
        return None  # check_data reports a bad timestamp
    age = now - generated
    if age > MAX_AGE:
        return (f"summary.json: generated_at is {int(age.total_seconds() // 60)} minutes old "
                f"(limit {int(MAX_AGE.total_seconds() // 60)})")
    return None


def error_problem(summary):
    polls = summary.get("polls_24h")
    if not isinstance(polls, dict) or not all(check_data.is_nonneg_int(polls.get(k)) for k in ("ok", "skipped", "error")):
        return None
    total = polls["ok"] + polls["skipped"] + polls["error"]
    if total and polls["error"] / total > MAX_ERROR_SHARE:
        return (f"summary.json: {polls['error']} of {total} checks in the last 24 hours failed "
                f"({polls['error'] / total:.0%}, limit {MAX_ERROR_SHARE:.0%})")
    return None


def late_problems(summary):
    """Newest price per source and zone against the 95th percentile of that series' delay."""
    p95 = {}
    for g in summary.get("groups") or []:
        if isinstance(g, dict) and g.get("data") == "imbalance" and isinstance(g.get("last7"), dict):
            p95[(g.get("source"), g.get("zone"))] = g["last7"].get("p95")
    out = []
    for e in summary.get("now") or []:
        if not isinstance(e, dict):
            continue
        limit = p95.get((e.get("source"), e.get("zone")))
        late = e.get("minutes_since_end")
        if not (check_data.is_num(limit) and check_data.is_num(late)):
            continue
        if late > limit + LATE_SLACK_MIN:
            out.append(f"{e['source']} {e['zone']}: newest price is {late:.0f} minutes old, "
                       f"more than its 95th percentile of {limit:.0f} plus {LATE_SLACK_MIN} minutes")
    return out


def freshness_problems(summary, now):
    """Reasons the summary shows a stalled or failing collector (empty = fine)."""
    if not isinstance(summary, dict):
        return []
    out = [p for p in (age_problem(summary, now), error_problem(summary)) if p]
    return out + late_problems(summary)


def download(base, directory, fetch):
    """Save every data file into the directory; returns the problems met on the way."""
    errors = []
    for name in FILES:
        url = f"{base.rstrip('/')}/data/{name}"
        try:
            body = fetch(url)
        except Exception as e:  # a network error of any kind is a finding, not a crash
            errors.append(f"{name}: could not be downloaded ({e})")
            continue
        (Path(directory) / name).write_bytes(body)
    return errors


def fetch_url(url):
    req = urllib.request.Request(url, headers={"User-Agent": "nbw-freshness-check", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read()


def run(base, fetch=fetch_url, now=None):
    """All problems with the live data at `base`."""
    now = now or datetime.now(timezone.utc)
    with tempfile.TemporaryDirectory() as tmp:
        problems = download(base, tmp, fetch)
        downloaded = {p.name for p in Path(tmp).iterdir()}
        # A file that could not be downloaded is already reported; check_data would only say "missing".
        problems += [e for e in check_data.check_dir(tmp) if e.split(":")[0] in downloaded]
        summary_path = Path(tmp) / "summary.json"
        if summary_path.is_file():
            try:
                problems += freshness_problems(json.loads(summary_path.read_text(encoding="utf-8")), now)
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                pass  # check_data reports unreadable JSON
    return problems


def main(argv):
    if len(argv) > 2:
        print("usage: check_live.py [base URL]", file=sys.stderr)
        return 2
    base = argv[1] if len(argv) == 2 else os.environ.get("NBW_BASE_URL") or DEFAULT_BASE
    problems = run(base)
    for p in problems:
        print(f"PROBLEM: {p}", file=sys.stderr)
    if problems:
        return 1
    print(f"OK: {base} data is valid and fresh")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
