#!/usr/bin/env python3
"""Validate a collector data directory against the site data contract (schema 1).

Usage: check_data.py <directory containing summary.json and revisions.json>
Exits 0 when both files are valid, 1 with one line per problem otherwise.
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
KINDS = {"changed", "withdrawn"}


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
    for k in ("p50", "p95", "max", "lag_p50_h", "lag_max_h"):
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
            for k in ("p50", "p95"):
                if d.get(k) is not None and not is_num(d.get(k)):
                    errors.append(f"{w}: {k} must be a number or null")
    if keys != sorted(keys):
        errors.append(f"{name}: groups must be sorted by source, data, zone")
    check_now(data.get("now"), errors)


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
        elif kind == "changed" and not is_num(r.get("new")):
            errors.append(f"{where}: changed entries must have a numeric new")


def check_dir(directory):
    """Return a list of problems found in the data directory (empty = valid)."""
    directory = Path(directory)
    errors = []
    summary = check_file(directory / "summary.json", errors)
    revisions = check_file(directory / "revisions.json", errors)
    check_summary(summary, errors)
    check_revisions(revisions, errors)
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
