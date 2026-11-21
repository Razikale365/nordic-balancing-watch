"""Tests for scripts/check_live.py: the decisions are pure functions, so nothing here uses the network."""
import io
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "data"
sys.path.insert(0, str(ROOT / "scripts"))
import check_live  # noqa: E402

GENERATED = datetime(2026, 10, 24, 19, 0, tzinfo=timezone.utc)
NOW = datetime(2026, 11, 20, 23, 15, tzinfo=timezone.utc)
GAP_END = datetime(2026, 11, 20, 20, 0, tzinfo=timezone.utc)

# Imbalance providers per zone, as in the live files.
LIVE = {
    "entsoe": check_live.ZONES,
    "esett": check_live.ZONES,
    "energidataservice": ["DK1", "DK2"],
    "fingrid": ["FI"],
}


def summary():
    return json.loads((FIXTURE / "summary.json").read_text(encoding="utf-8"))


def series(source, zone, end_min_ago, p95=60, generated=NOW):
    """A Series whose last price period ended `end_min_ago` minutes before the file was generated."""
    end = None if end_min_ago is None else generated - timedelta(minutes=end_min_ago)
    return check_live.Series(source, zone, end, generated, p95)


def zone_file(zone, generated, ends):
    """A zone file with 672 periods; each provider in `ends` is priced up to its last end (or never)."""
    start = generated - timedelta(minutes=672 * 15)
    out = {"schema": 1, "generated_at": generated.strftime("%Y-%m-%dT%H:%M:%SZ"), "zone": zone,
           "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "interval_minutes": 15, "series": {}}
    for source, end in ends.items():
        values = [None] * 672
        if end is not None:
            for i in range(int((end - start).total_seconds() // 900)):
                values[i] = 50.0
        out["series"][source] = values
    return out


def incident(now=NOW):
    """The 27 live imbalance series, all current except ENTSO-E DK1 and DK2 (last price ended 20:00)."""
    out = []
    for source, zones in LIVE.items():
        for z in zones:
            late = source == "entsoe" and z in ("DK1", "DK2")
            out.append(series(source, z, minutes_before(now, GAP_END) if late else 20, generated=now))
    return out


def minutes_before(now, moment):
    return int((now - moment).total_seconds() // 60)


def replace(items, source, zone, end_min_ago, now=NOW):
    return [series(source, zone, end_min_ago, generated=now) if (s.source, s.zone) == (source, zone) else s
            for s in items]


def gaps(findings):
    return [f for f in findings if f.kind == "source_gap"]


# ---- collector findings ----

def test_fresh_summary_has_no_findings():
    assert check_live.collector_findings(summary(), {}, GENERATED + timedelta(minutes=10)) == []


def test_summary_older_than_45_minutes_is_reported():
    assert check_live.collector_findings(summary(), {}, GENERATED + timedelta(minutes=45)) == []
    found = check_live.collector_findings(summary(), {}, GENERATED + timedelta(minutes=46))
    assert len(found) == 1 and found[0].kind == "data_age" and found[0].fails
    assert "generated_at is 46 minutes old" in found[0].message


def test_more_than_a_tenth_of_failed_checks_is_reported():
    s = summary()
    s["polls_24h"] = {"ok": 90, "skipped": 0, "error": 10}
    assert check_live.collector_findings(s, {}, GENERATED) == []
    s["polls_24h"] = {"ok": 89, "skipped": 0, "error": 11}
    found = check_live.collector_findings(s, {}, GENERATED)
    assert len(found) == 1 and found[0].kind == "check_errors" and "11 of 100 checks" in found[0].message


def test_no_checks_at_all_is_not_a_failure_share():
    s = summary()
    s["polls_24h"] = {"ok": 0, "skipped": 0, "error": 0}
    assert check_live.collector_findings(s, {}, GENERATED) == []


def test_a_zone_file_older_than_45_minutes_is_reported():
    old = GENERATED - timedelta(minutes=46)
    zf = zone_file("DK1", old, {"esett": old})
    found = check_live.collector_findings(summary(), {"DK1": zf}, GENERATED)
    assert len(found) == 1 and found[0].kind == "data_age"
    assert "zone-DK1.json: generated_at is 46 minutes old" in found[0].message
    assert "summary.json" not in found[0].message


# ---- source findings ----

def test_the_incident_is_one_warning_about_entsoe():
    found = check_live.source_findings(incident(), NOW)
    assert not any(f.fails for f in found)
    assert len(found) == 1 and found[0].kind == "source_gap" and not found[0].fails
    assert found[0].source == "entsoe" and found[0].zones == ("DK1", "DK2")
    for text in ("after 2026-11-20 20:00 UTC (3 h 15 min)", "ENTSO-E's other 10 zones are current",
                 "eSett and Energinet cover DK1 and DK2", "1 of 4 providers is behind"):
        assert text in found[0].message


def test_a_gap_fails_in_the_first_alert_window_and_in_the_morning_window():
    def fails(age, hour, minute):
        now = datetime(2026, 11, 21, hour, minute, tzinfo=timezone.utc)
        items = incident(now)
        for z in ("DK1", "DK2"):
            items = replace(items, "entsoe", z, age, now)
        return gaps(check_live.source_findings(items, now))[0].fails

    assert [fails(a, 15, 0) for a in (359, 360, 449, 450)] == [False, True, True, False]
    assert [fails(1500, h, m) for h, m in ((6, 0), (7, 29), (5, 59), (7, 30))] == [True, True, False, False]
    assert fails(400, 6, 30)
    assert not fails(500, 6, 30)


def test_a_provider_with_no_price_in_a_week_has_an_unknown_age():
    def found(dk1_end, dk2_end, hour, minute):
        now = datetime(2026, 11, 21, hour, minute, tzinfo=timezone.utc)
        items = replace(replace(incident(now), "entsoe", "DK1", dk1_end, now), "entsoe", "DK2", dk2_end, now)
        return gaps(check_live.source_findings(items, now))[0]

    for hour, minute, expected in ((6, 0, True), (7, 29, True), (5, 59, False), (7, 30, False)):
        f = found(None, None, hour, minute)
        assert f.fails is expected and "in the last 7 days" in f.message
    known = found(None, 600, 15, 0)  # DK2's last price still gives the age
    assert "(10 h 0 min)" in known.message and not known.fails


def test_a_zone_without_a_current_price_fails_and_leaves_the_other_zone_a_gap():
    items = replace(replace(incident(), "energidataservice", "DK1", 600), "esett", "DK1", 600)
    found = check_live.source_findings(items, NOW)
    uncovered = [f for f in found if f.kind == "zone_uncovered"]
    assert len(uncovered) == 1 and uncovered[0].fails and uncovered[0].zones == ("DK1",)
    assert "3 of 4 providers" in uncovered[0].message
    (gap,) = gaps(found)
    assert gap.source == "entsoe" and gap.zones == ("DK2",) and "3 of 4 providers" in gap.message


def test_every_entsoe_zone_late_and_dk1_uncovered():
    items = incident()
    for z in check_live.ZONES:
        items = replace(items, "entsoe", z, 600)
    items = replace(replace(items, "energidataservice", "DK1", 600), "esett", "DK1", 600)
    found = check_live.source_findings(items, NOW)
    assert [f.zones for f in found if f.kind == "zone_uncovered"] == [("DK1",)]
    (gap,) = gaps(found)
    assert gap.source == "entsoe" and gap.zones == tuple(z for z in check_live.ZONES if z != "DK1")
    assert "ENTSO-E is current in no zone" in gap.message


def test_fingrid_late_is_a_warning_covered_by_entsoe_and_esett():
    found = check_live.source_findings(replace(incident(), "fingrid", "FI", 600), NOW)
    fingrid = [f for f in gaps(found) if f.source == "fingrid"]
    assert len(fingrid) == 1 and not fingrid[0].fails and "ENTSO-E and eSett cover FI" in fingrid[0].message


def test_every_series_late_is_a_collector_fault_not_provider_gaps():
    items = [series(s.source, s.zone, 600) for s in incident()]
    collector = check_live.collector_findings(summary(), {}, GENERATED, items)
    assert [f.kind for f in collector] == ["fetching_stopped"] and collector[0].fails

    some = [series(s.source, s.zone, 20) for s in incident()]
    for s in list(some):
        if s.source in ("energidataservice", "fingrid"):
            some = replace(some, s.source, s.zone, 600)
    assert not any(f.kind == "fetching_stopped"
                   for f in check_live.collector_findings(summary(), {}, GENERATED, some))
    found = gaps(check_live.source_findings(some, NOW))
    assert sorted(f.source for f in found if f.source in ("energidataservice", "fingrid")) == [
        "energidataservice", "fingrid"]
    assert all("2 of 4 providers" in f.message for f in found if f.source in ("energidataservice", "fingrid"))


def test_the_lateness_limit_is_the_capped_95th_percentile_plus_two_hours():
    assert check_live.is_current(series("esett", "DK1", 360, p95=None))
    assert not check_live.is_current(series("esett", "DK1", 361, p95=None))
    assert check_live.limit(series("esett", "DK1", 0, p95=600)) == 360
    assert check_live.is_current(series("esett", "DK1", 208, p95=88))
    assert not check_live.is_current(series("esett", "DK1", 209, p95=88))
    assert not check_live.is_current(series("esett", "DK1", None))


def test_workflow_command_escaping():
    assert check_live.escape_title("a, b: c") == "a%2C b%3A c"
    assert check_live.escape_data("50% done\nnext") == "50%25 done%0Anext"
    assert check_live.escape_data("a\rb") == "a%0Db"


# ---- reading the zone files ----

def test_last_period_end_comes_from_the_price_grid():
    zf = zone_file("DK1", NOW, {"a": NOW - timedelta(minutes=15)})
    assert zf["series"]["a"][670] == 50.0 and zf["series"]["a"][671] is None
    start = check_live.parse_ts(zf["start"])
    assert check_live.last_period_end(zf, "a") == start + timedelta(minutes=671 * 15)
    zf["series"]["none"] = [None] * 672
    assert check_live.last_period_end(zf, "none") is None
    assert check_live.last_period_end(zf, "missing") is None


def test_extract_ignores_other_providers_and_skips_missing_zone_files():
    s = summary()
    zf = zone_file("DK1", GENERATED, {"esett": GENERATED, "svk": GENERATED})
    found = check_live.extract(s, {"DK1": zf})
    assert [(x.source, x.zone) for x in found] == [("esett", "DK1")]  # entsoe FI, esett DK2 have no file
    assert found[0].last_end == GENERATED and found[0].p95 == 92.0 and found[0].file_generated == GENERATED


# ---- running against files ----

def serve_fixture(url):
    """Stands in for the network: the fixture's files, with its one zone file under every zone name."""
    name = url.rsplit("/", 1)[1]
    if name.startswith("zone-"):
        z = json.loads((FIXTURE / "zone-SE3.json").read_text(encoding="utf-8"))
        z["zone"] = name[5:-5]
        return json.dumps(z).encode()
    return (FIXTURE / name).read_bytes()


def test_run_accepts_fresh_valid_files():
    found = check_live.run("https://example.test", serve_fixture, GENERATED + timedelta(minutes=5))
    assert not any(f.fails for f in found)


def test_run_reports_a_collector_that_stopped_fetching_and_no_provider_gaps():
    def fetch(url):
        body = serve_fixture(url)
        if "/zone-" in url:
            z = json.loads(body)
            z["series"] = {k: [None] * len(v) for k, v in z["series"].items()}
            z.pop("unconfirmed_zeros", None)
            return json.dumps(z).encode()
        return body
    found = check_live.run("https://example.test", fetch, GENERATED + timedelta(minutes=5))
    kinds = [f.kind for f in found]
    assert "fetching_stopped" in kinds
    assert not {"download", "contract", "zone_uncovered", "source_gap"} & set(kinds)


def test_run_reports_stale_data_and_a_file_that_cannot_be_downloaded():
    def fetch(url):
        if url.endswith("zone-NO3.json"):
            raise OSError("HTTP 502")
        return serve_fixture(url)
    found = check_live.run("https://example.test/", fetch, GENERATED + timedelta(hours=3))
    ages = [f for f in found if f.kind == "data_age"]
    assert len(ages) == 1 and ages[0].fails and "generated_at is 180 minutes old" in ages[0].message
    downloads = [f for f in found if f.kind == "download"]
    assert [f.message for f in downloads] == ["zone-NO3.json: could not be downloaded (HTTP 502)"]
    assert not any("zone-NO3.json: missing" in f.message for f in found)
    assert [f.fails for f in found if f.kind == "sources_unread"] == [False]


def test_run_reports_a_file_that_breaks_the_contract():
    def fetch(url):
        body = serve_fixture(url)
        if url.endswith("/summary.json"):
            s = json.loads(body)
            s["schema"] = 2
            return json.dumps(s).encode()
        return body
    found = check_live.run("https://example.test", fetch, GENERATED)
    contract = [f for f in found if f.kind == "contract"]
    assert contract and all(f.fails for f in contract)
    assert any(f.message.startswith("summary.json: schema") for f in contract)
    assert [f.fails for f in found if f.kind == "sources_unread"] == [False]


def test_run_asks_for_the_data_path_of_the_base_url():
    seen = []

    def fetch(url):
        seen.append(url)
        return serve_fixture(url)
    check_live.run("https://example.test/", fetch, GENERATED)
    assert seen[0] == "https://example.test/data/summary.json" and len(seen) == 14


# ---- output and arguments ----

def finding(kind, fails, source=None, message="m"):
    part = "collector" if kind in check_live.KIND_ORDER[:5] else "sources"
    return check_live.Finding(kind, part, fails, source, (), message)


def test_render_orders_failures_first_then_kind():
    items = [finding("source_gap", False, "entsoe", "warn"), finding("zone_uncovered", True, None, "zone"),
             finding("data_age", True, None, "age"), finding("source_gap", True, "esett", "gap")]
    out, err = io.StringIO(), io.StringIO()
    assert check_live.render(items, "all", out, err) == 1
    titles = [line.split("::")[1].split("title=")[1] for line in out.getvalue().splitlines()]
    assert titles == ["Collector stopped publishing", "Zone without a current price",
                      "Provider behind - zones covered", "Provider behind - zones covered"]
    assert out.getvalue().splitlines()[2].startswith("::error ") and out.getvalue().splitlines()[3].startswith("::warning ")
    assert err.getvalue().splitlines()[3] == "WARNING: warn"


def test_main_sources_part_with_warnings_only_exits_0(monkeypatch, capsys):
    monkeypatch.setattr(check_live, "run", lambda base: [finding("source_gap", False, "entsoe", "ENTSO-E: late, 50%")])
    assert check_live.main(["check_live.py", "--part", "sources", "https://example.test"]) == 0
    captured = capsys.readouterr()
    assert "::warning title=Provider behind - zones covered::ENTSO-E: late, 50%25" in captured.out.splitlines()
    assert "WARNING: ENTSO-E: late, 50%" in captured.err.splitlines()


def test_main_exit_code_follows_the_requested_part(monkeypatch, capsys):
    monkeypatch.setattr(check_live, "run", lambda base: [finding("source_gap", True, "entsoe")])
    assert check_live.main(["check_live.py", "--part", "sources"]) == 1
    assert check_live.main(["check_live.py", "--part", "collector"]) == 0
    assert check_live.main(["check_live.py"]) == 1
    out = capsys.readouterr().out
    assert out.count("::error title=Provider behind") == 2 and out.count("OK:") == 1


def test_main_rejects_bad_arguments(capsys):
    assert check_live.main(["check_live.py", "--part", "x"]) == 2
    assert check_live.main(["check_live.py", "--part"]) == 2
    assert check_live.main(["check_live.py", "a", "b", "c"]) == 2
    assert "usage:" in capsys.readouterr().err
