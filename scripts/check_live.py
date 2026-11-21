#!/usr/bin/env python3
"""Check that the live site's data files are valid and fresh, and tell a collector fault from a
provider's gap.

Usage: check_live.py [--part collector|sources|all] [base URL]
The base URL defaults to $NBW_BASE_URL, then https://nordic-balancing-watch.pages.dev.
Downloads summary.json, revisions.json and the 12 zone files, validates them with check_data.py,
and judges them in two parts. Every finding is printed as a GitHub annotation on stdout (an error
when it fails the check, a warning when not) and as a PROBLEM: or WARNING: line on stderr. The
exit code is 1 when a finding of the requested part fails, 2 for bad arguments, else 0.

Part "collector" (our collector or site is broken; fails on every run):
  download          a data file could not be downloaded;
  contract          a data file breaks the contract that check_data.py enforces;
  data_age          summary.json or a zone file was generated more than 45 minutes ago;
  check_errors      more than 10% of the collector's polls in the last 24 hours failed;
  fetching_stopped  no provider has a current price in any zone although the files are fresh.

Part "sources" (provider prices; judged only on files that downloaded and passed check_data.py):
  zone_uncovered    a zone has no current price from any provider; fails on every run;
  source_gap        one provider is behind in zones that other providers still cover. It is a
                    warning, and fails when the gap is 6 hours to 7 h 30 min old (first alert), and
                    on runs between 06:00 and 07:30 UTC once the gap is 12 hours old or its age is
                    unknown (morning reminder);
  sources_unread    the price files could not be read; a warning only.

A price series is current when the zone file's generated_at is at most min(p95, 240) + 120 minutes
after the end of its last price period, where p95 is the 95th percentile of that series' delay
over seven days (no value counts as 240). A series with no price in 7 days is late. The age of a
gap comes from the 7-day price grids in the zone files. Stdlib only.
"""
import json
import os
import sys
import tempfile
import urllib.request
from dataclasses import dataclass
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
P95_CAP_MIN = 240
GAP_ESCALATE_MIN = 360  # a gap fails the check (first alert) from this age
WINDOW_MIN = 90  # length of the first-alert window and of the morning-reminder window
REMINDER_MIN_AGE_MIN = 720
REMINDER_HOUR_UTC = 6
PERIOD_MIN = 15
PROVIDERS = {
    "entsoe": ("ENTSO-E", "https://transparency.entsoe.eu/balancing/imbalance"),
    "esett": ("eSett", "https://opendata.esett.com/"),
    "energidataservice": ("Energinet", "https://www.energidataservice.dk/tso-electricity/ImbalancePrice"),
    "fingrid": ("Fingrid", "https://data.fingrid.fi/"),
    "svk": ("Svenska kraftnät", None),
}
HEADLINES = {
    "download": "Site data unreachable",
    "contract": "Site data broken",
    "data_age": "Collector stopped publishing",
    "check_errors": "Collector polls failing",
    "fetching_stopped": "Collector stopped fetching",
    "zone_uncovered": "Zone without a current price",
    "source_gap": "Provider behind - zones covered",
    "sources_unread": "Price files unreadable",
}
KIND_ORDER = list(HEADLINES)
PARTS = ("collector", "sources", "all")
USAGE = "usage: check_live.py [--part collector|sources|all] [base URL]"


@dataclass(frozen=True)
class Series:
    """One provider's imbalance prices for one zone, as the zone file shows them."""
    source: str
    zone: str
    last_end: object  # datetime: end of the last non-null period, or None
    file_generated: object  # datetime: the zone file's generated_at
    p95: object  # the group's last7.p95, or None


@dataclass(frozen=True)
class Finding:
    kind: str
    part: str
    fails: bool
    source: object  # provider key or None
    zones: tuple
    message: str

    @property
    def title(self):
        return HEADLINES[self.kind]


def parse_ts(value):
    """An ISO timestamp ending in Z as an aware datetime, or None."""
    if not check_data.is_ts(value):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def last_period_end(zone_file, source):
    """End of the last non-null 15-minute period of a provider in a zone file, or None."""
    start = parse_ts(zone_file.get("start"))
    series = zone_file.get("series")
    values = series.get(source) if isinstance(series, dict) else None
    if start is None or not isinstance(values, list):
        return None
    for i in range(len(values) - 1, -1, -1):
        if values[i] is not None:
            return start + timedelta(minutes=PERIOD_MIN * (i + 1))
    return None


def extract(summary, zone_files):
    """One Series per imbalance group whose zone file is present."""
    out = []
    for g in summary.get("groups") or []:
        if not (isinstance(g, dict) and g.get("data") == "imbalance"):
            continue
        zf = zone_files.get(g.get("zone"))
        if not isinstance(zf, dict):
            continue
        generated = parse_ts(zf.get("generated_at"))
        if generated is None:
            continue
        last7 = g.get("last7")
        p95 = last7.get("p95") if isinstance(last7, dict) else None
        out.append(Series(g.get("source"), g.get("zone"), last_period_end(zf, g.get("source")), generated,
                          p95 if check_data.is_num(p95) else None))
    return out


def limit(series):
    """Minutes a series may be late and still count as current."""
    p95 = P95_CAP_MIN if series.p95 is None else min(series.p95, P95_CAP_MIN)
    return p95 + LATE_SLACK_MIN


def lateness(series):
    """Minutes from the end of the last price period to the zone file's generated_at, or None."""
    if series.last_end is None:
        return None
    return (series.file_generated - series.last_end).total_seconds() / 60


def is_current(series):
    late = lateness(series)
    return late is not None and late <= limit(series)


def gap_fails(age, now):
    """Whether a gap of `age` minutes (None when unknown) fails a run that starts at `now`."""
    if age is not None and GAP_ESCALATE_MIN <= age < GAP_ESCALATE_MIN + WINDOW_MIN:
        return True
    if age is None or age >= REMINDER_MIN_AGE_MIN:
        minute = now.hour * 60 + now.minute
        return REMINDER_HOUR_UTC * 60 <= minute < REMINDER_HOUR_UTC * 60 + WINDOW_MIN
    return False


def escape_data(text):
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def escape_title(text):
    return escape_data(text).replace(":", "%3A").replace(",", "%2C")


def provider_rank(source):
    keys = list(PROVIDERS)
    return keys.index(source) if source in keys else len(keys)


def provider_name(source):
    return PROVIDERS[source][0] if source in PROVIDERS else str(source)


def zone_rank(zone):
    return ZONES.index(zone) if zone in ZONES else len(ZONES)


def join_and(items):
    items = list(items)
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def fmt_age(minutes):
    minutes = int(minutes)
    return f"{minutes // 60} h {minutes % 60} min" if minutes >= 60 else f"{minutes} min"


def fmt_time(moment):
    return moment.strftime("%Y-%m-%d %H:%M UTC")


def minutes_between(later, earlier):
    return (later - earlier).total_seconds() / 60


def collector_findings(summary, zone_files, now, series=None):
    """Findings about our collector and site, from summary.json and the zone files."""
    out = []
    stale = []
    files = [("summary.json", summary)] + [(f"zone-{z}.json", zone_files[z]) for z in ZONES if z in zone_files]
    for name, data in files:
        generated = parse_ts(data.get("generated_at")) if isinstance(data, dict) else None
        if generated is not None and now - generated > MAX_AGE:  # check_data reports a bad timestamp
            stale.append((name, int((now - generated).total_seconds() // 60)))
    if stale:
        listing = "; ".join(f"{n}: generated_at is {m} minutes old (limit {int(MAX_AGE.total_seconds() // 60)})"
                            for n, m in stale)
        out.append(Finding("data_age", "collector", True, None, (),
                           f"{listing}. The collector has probably stopped or cannot publish; check that its "
                           "service on the VM is running."))
    polls = summary.get("polls_24h")
    if isinstance(polls, dict) and all(check_data.is_nonneg_int(polls.get(k)) for k in ("ok", "skipped", "error")):
        total = polls["ok"] + polls["skipped"] + polls["error"]
        if total and polls["error"] / total > MAX_ERROR_SHARE:
            out.append(Finding("check_errors", "collector", True, None, (),
                               f"summary.json: {polls['error']} of {total} checks in the last 24 hours failed "
                               f"({polls['error'] / total:.0%}, limit {MAX_ERROR_SHARE:.0%}). "
                               "Check the collector's log."))
    if series and not any(is_current(s) for s in series):
        out.append(Finding("fetching_stopped", "collector", True, None, (),
                           "No provider has a current price in any zone while the data files are fresh: the "
                           "collector is publishing but not fetching. Check the collector's log."))
    return out


def cover_text(zones, covering):
    """'eSett and Energinet cover DK1 and DK2; ...' for the zones of a gap."""
    groups = {}
    for z in zones:
        groups.setdefault(tuple(covering[z]), []).append(z)
    parts = []
    for names, zs in groups.items():
        verb = "covers" if len(names) == 1 else "cover"
        parts.append(f"{join_and(provider_name(n) for n in names)} {verb} {join_and(zs)}")
    return "; ".join(parts)


def source_findings(series, now):
    """Findings about providers: uncovered zones and gaps that other providers cover."""
    by_zone = {}
    for s in series:
        by_zone.setdefault(s.zone, []).append(s)
    zones = sorted(by_zone, key=zone_rank)
    providers = sorted({s.source for s in series}, key=provider_rank)
    behind = {s.source for s in series if not is_current(s)}
    verb = "is" if len(behind) == 1 else "are"
    count = f"{len(behind)} of {len(providers)} providers {verb} behind; if several are, check the collector first."
    covering = {z: sorted({s.source for s in by_zone[z] if is_current(s)}, key=provider_rank) for z in zones}
    uncovered = [z for z in zones if not covering[z]]
    out = []
    if uncovered:
        per_zone = ""
        shown = set()
        for z in uncovered:
            parts = []
            for s in sorted(by_zone[z], key=lambda x: provider_rank(x.source)):
                shown.add(s.source)
                if s.last_end is None:
                    parts.append(f"{provider_name(s.source)} none in 7 days")
                else:
                    parts.append(f"{provider_name(s.source)} {fmt_age(minutes_between(now, s.last_end))} behind")
            per_zone += f"{z}: {', '.join(parts)}. "
        pages = [f"{provider_name(p)} {PROVIDERS[p][1]}" for p in sorted(shown, key=provider_rank)
                 if p in PROVIDERS and PROVIDERS[p][1]]
        message = (f"No provider has a current price for {join_and(uncovered)}. {per_zone}"
                   f"Visitors see stale prices for these zones. {count}")
        if pages:
            message += f" Pages to check: {'; '.join(pages)}."
        out.append(Finding("zone_uncovered", "sources", True, None, tuple(uncovered), message))
    for source in providers:
        late = [s for s in series if s.source == source and not is_current(s) and covering[s.zone]]
        if not late:
            continue
        name = provider_name(source)
        gap_zones = tuple(sorted({s.zone for s in late}, key=zone_rank))
        known = [s.last_end for s in late if s.last_end is not None]
        age = minutes_between(now, min(known)) if known else None
        fails = gap_fails(age, now)
        current_n = sum(1 for s in series if s.source == source and is_current(s))
        if current_n:
            other = (f"{name}'s other zone is current" if current_n == 1
                     else f"{name}'s other {current_n} zones are current")
        else:
            other = (f"{name} is current in no zone: either {name} is down or our {name} fetcher or key has "
                     "stopped working")
        if age is None:
            what = f"no imbalance price for {join_and(gap_zones)} in the last 7 days"
        else:
            what = (f"no imbalance price for {join_and(gap_zones)} for periods after {fmt_time(min(known))} "
                    f"({fmt_age(age)})")
        if fails:
            when = ("First alert: the gap is 6 hours old."
                    if age is not None and GAP_ESCALATE_MIN <= age < GAP_ESCALATE_MIN + WINDOW_MIN
                    else "Morning reminder.")
        elif age is not None and age < GAP_ESCALATE_MIN:
            when = ("This fails the check when the gap is 6 hours old, and each day from 06:00 to 07:30 UTC "
                    "once it is 12 hours old.")
        else:
            when = "This fails the check each day from 06:00 to 07:30 UTC while it lasts."
        page = PROVIDERS[source][1] if source in PROVIDERS else None
        page_text = (f" If {name}'s page shows prices for these periods, our collector probably missed them: "
                     f"{page}." if page else "")
        message = f"{name}: {what}. {other}. {cover_text(gap_zones, covering)}. {count}{page_text} {when}"
        out.append(Finding("source_gap", "sources", fails, source, gap_zones, message))
    return out


def download(base, directory, fetch):
    """Save every data file into the directory; returns the problems met on the way."""
    errors = []
    for name in FILES:
        url = f"{base.rstrip('/')}/data/{name}"
        try:
            try:
                body = fetch(url)
            except Exception:  # one retry, so a single dropped request does not raise an alarm
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


def read_json_object(path):
    """The parsed file when it is a JSON object, else None."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def run(base, fetch=fetch_url, now=None):
    """All findings about the live data at `base`."""
    now = now or datetime.now(timezone.utc)
    findings = []
    with tempfile.TemporaryDirectory() as tmp:
        download_errors = download(base, tmp, fetch)
        downloaded = {p.name for p in Path(tmp).iterdir()}
        # A file that could not be downloaded is already reported; check_data would only say "missing".
        contract_errors = [e for e in check_data.check_dir(tmp) if e.split(":")[0] in downloaded]
        findings += [Finding("download", "collector", True, None, (), e) for e in download_errors]
        findings += [Finding("contract", "collector", True, None, (), e) for e in contract_errors]
        summary = read_json_object(Path(tmp) / "summary.json")
        zone_files = {}
        for z in ZONES:
            zf = read_json_object(Path(tmp) / f"zone-{z}.json")
            if zf is not None:
                zone_files[z] = zf
        if not download_errors and not contract_errors and summary is not None:
            series = extract(summary, zone_files)
            collector = collector_findings(summary, zone_files, now, series)
            findings += collector
            if not any(f.kind == "fetching_stopped" for f in collector):
                findings += source_findings(series, now)
        else:
            if summary is not None:
                findings += collector_findings(summary, zone_files, now)
            findings.append(Finding("sources_unread", "sources", False, None, (),
                                    "The price files could not be read in this job; the next run checks again."))
    return findings


def sort_key(f):
    return (not f.fails, KIND_ORDER.index(f.kind), provider_rank(f.source) if f.source else -1, f.zones)


def render(findings, part, out, err):
    """Print the findings of a part as annotations (out) and plain lines (err); 1 if any fails."""
    kept = sorted((f for f in findings if part == "all" or f.part == part), key=sort_key)
    for f in kept:
        level, prefix = ("error", "PROBLEM") if f.fails else ("warning", "WARNING")
        print(f"::{level} title={escape_title(f.title)}::{escape_data(f.message)}", file=out)
        print(f"{prefix}: {f.message}", file=err)
    return 1 if any(f.fails for f in kept) else 0


def main(argv):
    args = argv[1:]
    part = "all"
    if args[:1] == ["--part"]:
        if len(args) < 2 or args[1] not in PARTS:
            print(USAGE, file=sys.stderr)
            return 2
        part = args[1]
        args = args[2:]
    if len(args) > 1 or (args and args[0].startswith("--")):
        print(USAGE, file=sys.stderr)
        return 2
    base = args[0] if args else os.environ.get("NBW_BASE_URL") or DEFAULT_BASE
    code = render(run(base), part, sys.stdout, sys.stderr)
    if code == 0:
        print(f"OK: {base} data is valid and fresh")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
