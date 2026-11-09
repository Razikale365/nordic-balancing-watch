"""Tests for scripts/check_live.py: the decisions are pure functions, so nothing here uses the network."""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "data"
sys.path.insert(0, str(ROOT / "scripts"))
import check_live  # noqa: E402

GENERATED = datetime(2026, 10, 24, 19, 0, tzinfo=timezone.utc)


def summary():
    return json.loads((FIXTURE / "summary.json").read_text(encoding="utf-8"))


def test_fresh_summary_has_no_problems():
    assert check_live.freshness_problems(summary(), GENERATED + timedelta(minutes=10)) == []


def test_summary_older_than_45_minutes_is_reported():
    assert check_live.freshness_problems(summary(), GENERATED + timedelta(minutes=45)) == []
    problems = check_live.freshness_problems(summary(), GENERATED + timedelta(minutes=46))
    assert len(problems) == 1 and "generated_at is 46 minutes old" in problems[0]


def test_more_than_a_tenth_of_failed_checks_is_reported():
    s = summary()
    s["polls_24h"] = {"ok": 90, "skipped": 0, "error": 10}
    assert check_live.freshness_problems(s, GENERATED) == []
    s["polls_24h"] = {"ok": 89, "skipped": 0, "error": 11}
    problems = check_live.freshness_problems(s, GENERATED)
    assert len(problems) == 1 and "11 of 100 checks" in problems[0]


def test_no_checks_at_all_is_not_a_failure_share():
    s = summary()
    s["polls_24h"] = {"ok": 0, "skipped": 0, "error": 0}
    assert check_live.freshness_problems(s, GENERATED) == []


def test_newest_price_later_than_the_95th_percentile_plus_two_hours_is_reported():
    s = summary()  # esett DK1 has a 95th percentile of 92 minutes
    s["now"] = [{"source": "esett", "zone": "DK1", "interval_start": "2026-10-24T14:00:00Z", "price": 50.0,
                 "unit": "EUR/MWh", "published_at": None, "minutes_since_end": 212.0}]
    assert check_live.freshness_problems(s, GENERATED) == []
    s["now"][0]["minutes_since_end"] = 212.5
    problems = check_live.freshness_problems(s, GENERATED)
    assert len(problems) == 1 and problems[0].startswith("esett DK1: newest price is ")


def test_series_without_a_95th_percentile_or_group_are_not_judged():
    s = summary()
    dk1 = next(g for g in s["groups"] if g["source"] == "esett" and g["zone"] == "DK1")
    dk1["last7"]["p95"] = None
    s["now"] = [
        {"source": "esett", "zone": "DK1", "interval_start": "2026-10-24T14:00:00Z", "price": 50.0, "unit": "EUR/MWh",
         "published_at": None, "minutes_since_end": 9999.0},
        {"source": "svk", "zone": "SE3", "interval_start": "2026-10-24T14:00:00Z", "price": 50.0, "unit": "EUR/MWh",
         "published_at": None, "minutes_since_end": 9999.0},
    ]
    assert check_live.freshness_problems(s, GENERATED) == []


def serve_fixture(url):
    """Stands in for the network: the fixture's files, with its one zone file under every zone name."""
    name = url.rsplit("/", 1)[1]
    if name.startswith("zone-"):
        z = json.loads((FIXTURE / "zone-SE3.json").read_text(encoding="utf-8"))
        z["zone"] = name[5:-5]
        return json.dumps(z).encode()
    return (FIXTURE / name).read_bytes()


def test_run_accepts_fresh_valid_files():
    assert check_live.run("https://example.test", serve_fixture, GENERATED + timedelta(minutes=5)) == []


def test_run_reports_stale_data_and_a_file_that_cannot_be_downloaded():
    def fetch(url):
        if url.endswith("zone-NO3.json"):
            raise OSError("HTTP 502")
        return serve_fixture(url)
    problems = check_live.run("https://example.test/", fetch, GENERATED + timedelta(hours=3))
    assert any("generated_at is 180 minutes old" in p for p in problems)
    assert "zone-NO3.json: could not be downloaded (HTTP 502)" in problems
    assert not any("zone-NO3.json: missing" in p for p in problems)


def test_run_reports_a_file_that_breaks_the_contract():
    def fetch(url):
        body = serve_fixture(url)
        if url.endswith("/summary.json"):
            s = json.loads(body)
            s["schema"] = 2
            return json.dumps(s).encode()
        return body
    problems = check_live.run("https://example.test", fetch, GENERATED)
    assert any(p.startswith("summary.json: schema") for p in problems)


def test_run_asks_for_the_data_path_of_the_base_url():
    seen = []

    def fetch(url):
        seen.append(url)
        return serve_fixture(url)
    check_live.run("https://example.test/", fetch, GENERATED)
    assert seen[0] == "https://example.test/data/summary.json" and len(seen) == 14
