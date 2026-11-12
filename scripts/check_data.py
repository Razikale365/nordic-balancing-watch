#!/usr/bin/env python3
"""Validate a collector data directory against the site data contract (schema 1).

Usage: check_data.py <directory containing summary.json, revisions.json and any zone-<zone>.json>
Exits 0 when every file is valid, 1 with one line per problem otherwise.
Stdlib only.
"""
import json
import re
import sys
from pathlib import Path

MAX_BYTES = 1024 * 1024  # both files are under 1 MB
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SOURCES = {"esett", "energidataservice", "entsoe", "fingrid", "svk"}
FIELDS = {"imbalance_price_eur", "imbalance_price_dkk", "price_eur_per_mw"}
# "filled": a 0.00 another source already had the real price for; "unresolved": a change from
# 0.00 that no other source could confirm (added 2026-11-12). Neither is a revision.
KINDS = {"changed", "withdrawn", "completed", "filled", "unresolved"}
# Optional per-zone detail files, one per price zone, the same names the data function allows.
ZONE_FILE_RE = re.compile(r"^zone-(DK[12]|FI|NO[1-5]|SE[1-4])\.json$")
ZONE_CONTEXT = ("direction", "mfrr_up", "mfrr_down")


def is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def is_int(x):
    return isinstance(x, int) and not isinstance(x, bool)


def is_nonneg_int(x):
    return is_int(x) and x >= 0


def is_ts(x):
    return isinstance(x, str) and bool(TS_RE.match(x))


def is_str(x):
    return isinstance(x, str) and x != ""


def check_file(path, errors):
    """Parse one JSON file, appending structural errors. Returns the object or None."""
    if not path.is_file():
        errors.append(f"{path.name}: missing")
        return None
    size = path.stat().st_size
    if size >= MAX_BYTES:
        errors.append(f"{path.name}: {size} bytes is not under 1 MB")
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        errors.append(f"{path.name}: not valid JSON ({e})")
        return None
    if not isinstance(data, dict):
        errors.append(f"{path.name}: top level is not an object")
        return None
    if data.get("schema") != 1 or not is_int(data.get("schema")):
        errors.append(f"{path.name}: schema must be the integer 1")
    if not is_ts(data.get("generated_at")):
        errors.append(f"{path.name}: generated_at must be an ISO timestamp ending in Z")
    return data


def check_last7(l, where, errors):
    if not isinstance(l, dict):
        errors.append(f"{where}: last7 must be an object")
        return
    for k in ("n", "excluded", "published", "revised", "revisions", "withdrawn"):
        if not is_nonneg_int(l.get(k)):
            errors.append(f"{where}: last7.{k} must be a non-negative integer")
    # Added 2026-10-28; older data files do not have it.
    if "currency_recalculations" in l and not is_nonneg_int(l["currency_recalculations"]):
        errors.append(f"{where}: last7.currency_recalculations must be a non-negative integer")
    # Added 2026-11-09: later auctions completing the provisional total, not revisions.
    if "completions" in l and not is_nonneg_int(l["completions"]):
        errors.append(f"{where}: last7.completions must be a non-negative integer")
    # Optional: the start of the 15-minute interval behind `max`.
    if l.get("max_start") is not None and not is_ts(l["max_start"]):
        errors.append(f"{where}: last7.max_start must be an ISO timestamp ending in Z or null")
    # Added 2026-11-11: prices first seen more than 48 hours late (counted, not timed), and
    # for reserve products the quarter-hours first seen after delivery had started.
    for k in ("late", "seen_after_start", "filled", "unresolved"):
        if k in l and not is_nonneg_int(l[k]):
            errors.append(f"{where}: last7.{k} must be a non-negative integer")
    # Added 2026-11-12: reserve revisions made after delivery, decided per change (null for
    # imbalance prices, which are only ever revised after delivery).
    rad = l.get("revisions_after_delivery")
    if rad is not None and not is_nonneg_int(rad):
        errors.append(f"{where}: last7.revisions_after_delivery must be a non-negative integer or null")
    # late_max_h: the longest of those delays in hours. from_start_p50, from_start_p95:
    # minutes from the start of delivery to the first price (negative: before delivery).
    for k in ("p50", "p95", "max", "lag_p50_h", "lag_max_h",
              "completion_lag_p50_h", "completion_lag_max_h",
              "late_max_h", "from_start_p50", "from_start_p95"):
        if l.get(k) is not None and not is_num(l.get(k)):
            errors.append(f"{where}: last7.{k} must be a number or null")
    rs = l.get("revised_share")
    if rs is not None and not (is_num(rs) and 0 <= rs <= 1):
        errors.append(f"{where}: last7.revised_share must be a share in [0, 1] or null")


def check_summary(data, errors):
    if data is None:
        return
    name = "summary.json"
    if not is_ts(data.get("collecting_since")):
        errors.append(f"{name}: collecting_since must be an ISO timestamp ending in Z")
    if not is_nonneg_int(data.get("observations_total")):
        errors.append(f"{name}: observations_total must be a non-negative integer")
    polls = data.get("polls_24h")
    if not isinstance(polls, dict):
        errors.append(f"{name}: polls_24h must be an object")
    else:
        for k in ("ok", "skipped", "error"):
            if not is_nonneg_int(polls.get(k)):
                errors.append(f"{name}: polls_24h.{k} must be a non-negative integer")
    check_http(data.get("http_24h"), errors)
    groups = data.get("groups")
    if not isinstance(groups, list):
        errors.append(f"{name}: groups must be a list")
        return
    keys = []
    for i, g in enumerate(groups):
        where = f"{name}: groups[{i}]"
        if not isinstance(g, dict):
            errors.append(f"{where}: must be an object")
            continue
        if g.get("source") not in SOURCES:
            errors.append(f"{where}: unknown source {g.get('source')!r}")
        if not is_str(g.get("data")):
            errors.append(f"{where}: data must be a non-empty string")
        if not is_str(g.get("zone")):
            errors.append(f"{where}: zone must be a non-empty string")
        key = (g.get("source"), g.get("data"), g.get("zone"))
        if all(isinstance(k, str) for k in key):
            keys.append(key)
        check_last7(g.get("last7"), where, errors)
        daily = g.get("daily")
        if not isinstance(daily, list) or len(daily) > 30:
            errors.append(f"{where}: daily must be a list of at most 30 entries")
            continue
        prev = None
        for j, d in enumerate(daily):
            w = f"{where}.daily[{j}]"
            if not isinstance(d, dict):
                errors.append(f"{w}: must be an object")
                continue
            day = d.get("day")
            if not (isinstance(day, str) and DAY_RE.match(day)):
                errors.append(f"{w}: day must be YYYY-MM-DD")
            else:
                if prev is not None and day <= prev:
                    errors.append(f"{where}: daily days must be oldest first")
                prev = day
            for k in ("n", "published", "revised", "revisions"):
                if not is_nonneg_int(d.get(k)):
                    errors.append(f"{w}: {k} must be a non-negative integer")
            if "completions" in d and not is_nonneg_int(d["completions"]):
                errors.append(f"{w}: completions must be a non-negative integer")
            for k in ("p50", "p95"):
                if d.get(k) is not None and not is_num(d.get(k)):
                    errors.append(f"{w}: {k} must be a number or null")
    if keys != sorted(keys):
        errors.append(f"{name}: groups must be sorted by source, data, zone")
    check_completions_7d(data.get("completions_7d"), errors)
    check_now(data.get("now"), errors)


def check_completions_7d(c, errors):
    """Optional counts of prices completed by a later auction in the window."""
    if c is None:
        return
    name = "summary.json: completions_7d"
    if not isinstance(c, dict):
        errors.append(f"{name} must be an object")
        return
    for k in ("zone_intervals", "market_intervals"):
        if not is_nonneg_int(c.get(k)):
            errors.append(f"{name}.{k} must be a non-negative integer")


def check_http(rows, errors):
    """Optional per-source HTTP request counts of the last 24 hours."""
    if rows is None:
        return
    name = "summary.json: http_24h"
    if not isinstance(rows, list):
        errors.append(f"{name} must be a list")
        return
    for i, e in enumerate(rows):
        where = f"{name}[{i}]"
        if not isinstance(e, dict):
            errors.append(f"{where}: must be an object")
            continue
        if not is_str(e.get("source")):
            errors.append(f"{where}: source must be a non-empty string")
        for k in ("polls", "requests", "non_200"):
            if not is_nonneg_int(e.get(k)):
                errors.append(f"{where}: {k} must be a non-negative integer")
        if not is_num(e.get("retry_sleep_s")):
            errors.append(f"{where}: retry_sleep_s must be a number")


def check_now(now, errors):
    """Optional latest price per source and zone."""
    if now is None:
        return
    name = "summary.json: now"
    if not isinstance(now, list):
        errors.append(f"{name} must be a list")
        return
    for i, e in enumerate(now):
        where = f"{name}[{i}]"
        if not isinstance(e, dict):
            errors.append(f"{where}: must be an object")
            continue
        if e.get("source") not in SOURCES:
            errors.append(f"{where}: unknown source {e.get('source')!r}")
        if not is_str(e.get("zone")) or not is_str(e.get("unit")):
            errors.append(f"{where}: zone and unit must be non-empty strings")
        if not is_ts(e.get("interval_start")):
            errors.append(f"{where}: interval_start must be an ISO timestamp ending in Z")
        if e.get("published_at") is not None and not is_ts(e.get("published_at")):
            errors.append(f"{where}: published_at must be an ISO timestamp or null")
        for k in ("price", "minutes_since_end"):
            if not is_num(e.get(k)):
                errors.append(f"{where}: {k} must be a number")


def check_kept(kept, errors):
    """Optional description of what the capped log keeps."""
    if kept is None:
        return
    name = "revisions.json: kept"
    if not isinstance(kept, dict):
        errors.append(f"{name} must be an object")
        return
    for k in ("imbalance", "imbalance_total", "other", "other_total"):
        if not is_nonneg_int(kept.get(k)):
            errors.append(f"{name}.{k} must be a non-negative integer")
    if kept.get("other_since") is not None and not is_ts(kept["other_since"]):
        errors.append(f"{name}.other_since must be an ISO timestamp ending in Z or null")


def check_revisions(data, errors):
    if data is None:
        return
    name = "revisions.json"
    revs = data.get("revisions")
    if not isinstance(revs, list):
        errors.append(f"{name}: revisions must be a list")
        return
    if len(revs) > 500:
        errors.append(f"{name}: more than 500 revisions")
    check_kept(data.get("kept"), errors)
    prev_at = None
    for i, r in enumerate(revs):
        where = f"{name}: revisions[{i}]"
        if not isinstance(r, dict):
            errors.append(f"{where}: must be an object")
            continue
        if r.get("source") not in SOURCES:
            errors.append(f"{where}: unknown source {r.get('source')!r}")
        if not is_str(r.get("data")):
            errors.append(f"{where}: data must be a non-empty string")
        if not is_str(r.get("zone")):
            errors.append(f"{where}: zone must be a non-empty string")
        if not is_ts(r.get("interval_start")):
            errors.append(f"{where}: interval_start must be an ISO timestamp ending in Z")
        if not (is_int(r.get("interval_minutes")) and r["interval_minutes"] > 0):
            errors.append(f"{where}: interval_minutes must be a positive integer")
        if r.get("field") not in FIELDS:
            errors.append(f"{where}: unknown field {r.get('field')!r}")
        if not is_str(r.get("unit")):
            errors.append(f"{where}: unit must be a non-empty string")
        if not is_num(r.get("old")):
            errors.append(f"{where}: old must be a number")
        if not is_ts(r.get("first_published_at")):
            errors.append(f"{where}: first_published_at must be an ISO timestamp ending in Z")
        if not is_ts(r.get("revised_at")):
            errors.append(f"{where}: revised_at must be an ISO timestamp ending in Z")
        elif prev_at is not None and r["revised_at"] > prev_at:
            errors.append(f"{name}: revisions must be newest first")
        prev_at = r.get("revised_at") if is_ts(r.get("revised_at")) else prev_at
        kind = r.get("kind")
        if kind not in KINDS:
            errors.append(f"{where}: kind must be one of {sorted(KINDS)}")
        elif kind == "withdrawn" and r.get("new") is not None:
            errors.append(f"{where}: withdrawn entries must have new = null")
        elif kind in ("changed", "completed", "filled", "unresolved") and not is_num(r.get("new")):
            errors.append(f"{where}: {kind} entries must have a numeric new")
        # Added 2026-11-12, optional: what each other source held for the price when a
        # change from 0.00 was judged (empty when none held a price).
        others = r.get("others")
        if others is not None and not (
            isinstance(others, list)
            and all(isinstance(o, dict) and o.get("source") in SOURCES and is_num(o.get("value"))
                    for o in others)
        ):
            errors.append(f"{where}: others must be a list of {{source, value}} from known sources")


def check_zone(data, name, errors):
    """One zone's 7-day file: every source on one 15-minute grid starting at `start`."""
    if data is None:
        return
    m = ZONE_FILE_RE.match(name)
    if data.get("zone") != m.group(1):
        errors.append(f"{name}: zone must be {m.group(1)!r}")
    if not is_ts(data.get("start")):
        errors.append(f"{name}: start must be an ISO timestamp ending in Z")
    if data.get("interval_minutes") != 15:
        errors.append(f"{name}: interval_minutes must be 15")
    series = data.get("series")
    if not isinstance(series, dict) or not series:
        errors.append(f"{name}: series must be a non-empty object")
        series = {}
    arrays = {f"series.{s}": a for s, a in series.items()}
    arrays.update({k: data.get(k) for k in ZONE_CONTEXT})
    lengths = set()
    for k, a in arrays.items():
        if k.startswith("series.") and k[7:] not in SOURCES:
            errors.append(f"{name}: unknown source {k[7:]!r}")
        if not isinstance(a, list) or not all(v is None or is_num(v) for v in a):
            errors.append(f"{name}: {k} must be a list of numbers or nulls")
            continue
        lengths.add(len(a))
    if len(lengths) > 1:
        errors.append(f"{name}: every list must have the same length")
    n = lengths.pop() if len(lengths) == 1 else 0
    revs = data.get("revisions")
    if not isinstance(revs, list):
        errors.append(f"{name}: revisions must be a list")
        return
    for i, r in enumerate(revs):
        ok = (isinstance(r, list) and len(r) == 4 and is_int(r[0]) and 0 <= r[0] < n
              and r[1] in series and is_num(r[2]) and is_ts(r[3]))
        if not ok:
            errors.append(f"{name}: revisions[{i}] must be [index, source, first price, first seen]")


def check_dir(directory):
    """Return a list of problems found in the data directory (empty = valid)."""
    directory = Path(directory)
    errors = []
    summary = check_file(directory / "summary.json", errors)
    revisions = check_file(directory / "revisions.json", errors)
    check_summary(summary, errors)
    check_revisions(revisions, errors)
    for path in sorted(directory.glob("zone-*.json")):
        if not ZONE_FILE_RE.match(path.name):
            errors.append(f"{path.name}: not a price zone file name")
            continue
        check_zone(check_file(path, errors), path.name, errors)
    return errors


def main(argv):
    if len(argv) != 2:
        print("usage: check_data.py <data directory>", file=sys.stderr)
        return 2
    errors = check_dir(argv[1])
    for e in errors:
        print(f"ERROR: {e}", file=sys.stderr)
    if errors:
        return 1
    print(f"OK: {argv[1]} follows the schema-1 data contract")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
