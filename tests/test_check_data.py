"""Tests for scripts/check_data.py: the fixture passes, broken variants fail."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_data.py"
FIXTURE = ROOT / "tests" / "fixtures" / "data"


def run_check(directory):
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(directory)],
        capture_output=True, text=True,
    )


def make_dir(tmp_path, summary=None, revisions=None):
    d = tmp_path / "data"
    d.mkdir()
    s = json.loads((FIXTURE / "summary.json").read_text(encoding="utf-8"))
    r = json.loads((FIXTURE / "revisions.json").read_text(encoding="utf-8"))
    if summary:
        summary(s)
    if revisions:
        revisions(r)
    (d / "summary.json").write_text(json.dumps(s), encoding="utf-8")
    (d / "revisions.json").write_text(json.dumps(r), encoding="utf-8")
    return d


def test_fixture_passes():
    res = run_check(FIXTURE)
    assert res.returncode == 0, res.stderr


def test_wrong_schema_fails(tmp_path):
    def breakit(s):
        s["schema"] = 2
    res = run_check(make_dir(tmp_path, summary=breakit))
    assert res.returncode != 0
    assert "schema" in res.stderr


def test_bad_timestamp_fails(tmp_path):
    def breakit(s):
        s["generated_at"] = "2026-10-24 19:00:00"  # no T, no Z
    res = run_check(make_dir(tmp_path, summary=breakit))
    assert res.returncode != 0
    assert "generated_at" in res.stderr


def test_bad_latest_price_fails(tmp_path):
    def breakit(s):
        s["now"][0]["price"] = "48.12"
    res = run_check(make_dir(tmp_path, summary=breakit))
    assert res.returncode != 0
    assert "now[0]: price" in res.stderr


def test_bad_currency_recalculation_count_fails(tmp_path):
    def breakit(s):
        s["groups"][0]["last7"]["currency_recalculations"] = -1
    res = run_check(make_dir(tmp_path, summary=breakit))
    assert res.returncode != 0
    assert "currency_recalculations" in res.stderr


def test_bad_completion_count_fails(tmp_path):
    def breakit(s):
        s["groups"][0]["last7"]["completions"] = -1
    res = run_check(make_dir(tmp_path, summary=breakit))
    assert res.returncode != 0
    assert "completions" in res.stderr


def test_bad_daily_completion_count_fails(tmp_path):
    def breakit(s):
        s["groups"][0]["daily"][0]["completions"] = 2.5
    res = run_check(make_dir(tmp_path, summary=breakit))
    assert res.returncode != 0
    assert "completions" in res.stderr


def test_bad_completions_7d_fails(tmp_path):
    def breakit(s):
        s["completions_7d"] = {"zone_intervals": 315, "market_intervals": "63"}
    res = run_check(make_dir(tmp_path, summary=breakit))
    assert res.returncode != 0
    assert "completions_7d.market_intervals" in res.stderr


def test_completions_7d_must_be_an_object(tmp_path):
    def breakit(s):
        s["completions_7d"] = 63
    res = run_check(make_dir(tmp_path, summary=breakit))
    assert res.returncode != 0
    assert "completions_7d must be an object" in res.stderr


def test_bad_completion_lag_fails(tmp_path):
    def breakit(s):
        s["groups"][0]["last7"]["completion_lag_p50_h"] = "18"
    res = run_check(make_dir(tmp_path, summary=breakit))
    assert res.returncode != 0
    assert "completion_lag_p50_h" in res.stderr


def test_the_new_completion_fields_pass(tmp_path):
    def change(s):
        s["groups"][0]["last7"]["completions"] = 12
        s["groups"][0]["last7"]["completion_lag_p50_h"] = 18.0
        s["groups"][0]["last7"]["completion_lag_max_h"] = None
        s["groups"][0]["daily"][0]["completions"] = 4
        s["completions_7d"] = {"zone_intervals": 315, "market_intervals": 63}
    res = run_check(make_dir(tmp_path, summary=change))
    assert res.returncode == 0, res.stderr


def test_bad_max_start_fails(tmp_path):
    def breakit(s):
        s["groups"][0]["last7"]["max_start"] = "2026-10-22 13:00"
    res = run_check(make_dir(tmp_path, summary=breakit))
    assert res.returncode != 0
    assert "max_start" in res.stderr


def test_null_max_start_passes(tmp_path):
    def change(s):
        s["groups"][0]["last7"]["max_start"] = None
    res = run_check(make_dir(tmp_path, summary=change))
    assert res.returncode == 0, res.stderr


def test_bad_http_counts_fail(tmp_path):
    def breakit(s):
        s["http_24h"][0]["non_200"] = -1
        s["http_24h"][1]["retry_sleep_s"] = "4"
    res = run_check(make_dir(tmp_path, summary=breakit))
    assert res.returncode != 0
    assert "http_24h[0]: non_200" in res.stderr and "http_24h[1]: retry_sleep_s" in res.stderr


def test_http_counts_must_be_a_list(tmp_path):
    def breakit(s):
        s["http_24h"] = {"esett": 1}
    res = run_check(make_dir(tmp_path, summary=breakit))
    assert res.returncode != 0
    assert "http_24h must be a list" in res.stderr


def test_bad_kept_fails(tmp_path):
    def breakit(r):
        r["kept"]["other"] = -1
        r["kept"]["imbalance_total"] = 2.5
        r["kept"]["other_since"] = "yesterday"
    res = run_check(make_dir(tmp_path, revisions=breakit))
    assert res.returncode != 0
    assert "kept.other must" in res.stderr and "kept.imbalance_total" in res.stderr and "kept.other_since" in res.stderr


def test_kept_with_no_reserve_changes_passes(tmp_path):
    def change(r):
        r["kept"].update({"other": 0, "other_total": 0, "other_since": None})
    res = run_check(make_dir(tmp_path, revisions=change))
    assert res.returncode == 0, res.stderr


def test_missing_required_key_fails(tmp_path):
    def breakit(r):
        del r["revisions"][0]["revised_at"]
    res = run_check(make_dir(tmp_path, revisions=breakit))
    assert res.returncode != 0
    assert "revised_at" in res.stderr


def test_completed_kind_passes(tmp_path):
    def change(r):
        r["revisions"][1]["kind"] = "completed"
    res = run_check(make_dir(tmp_path, revisions=change))
    assert res.returncode == 0, res.stderr


def test_completed_kind_needs_a_numeric_new(tmp_path):
    def breakit(r):
        r["revisions"][1]["kind"] = "completed"
        r["revisions"][1]["new"] = None
    res = run_check(make_dir(tmp_path, revisions=breakit))
    assert res.returncode != 0
    assert "completed entries must have a numeric new" in res.stderr


def test_an_unknown_kind_fails(tmp_path):
    def breakit(r):
        r["revisions"][0]["kind"] = "corrected"
    res = run_check(make_dir(tmp_path, revisions=breakit))
    assert res.returncode != 0
    assert "kind" in res.stderr


def test_missing_file_fails(tmp_path):
    d = tmp_path / "empty"
    d.mkdir()
    res = run_check(d)
    assert res.returncode != 0
    assert "missing" in res.stderr


def zone_dir(tmp_path, change, name="zone-SE3.json"):
    d = tmp_path / "zones"
    shutil.copytree(FIXTURE, d)
    z = json.loads((FIXTURE / "zone-SE3.json").read_text(encoding="utf-8"))
    change(z)
    (d / "zone-SE3.json").unlink()
    (d / name).write_text(json.dumps(z), encoding="utf-8")
    return d


def test_zone_lists_of_different_lengths_fail(tmp_path):
    res = run_check(zone_dir(tmp_path, lambda z: z["direction"].pop()))
    assert res.returncode != 0
    assert "same length" in res.stderr


def test_zone_text_in_a_price_list_fails(tmp_path):
    def breakit(z):
        z["series"]["esett"][-2] = "<img src=x>"
    res = run_check(zone_dir(tmp_path, breakit))
    assert res.returncode != 0
    assert "series.esett" in res.stderr


def test_zone_revision_outside_the_grid_or_source_fails(tmp_path):
    def breakit(z):
        z["revisions"] = [[len(z["direction"]), "esett", 1.0, "2026-10-24T17:45:00Z"], [0, "svk", 1.0, "2026-10-24T17:45:00Z"]]
    res = run_check(zone_dir(tmp_path, breakit))
    assert res.returncode != 0
    assert "revisions[0]" in res.stderr and "revisions[1]" in res.stderr


def test_zone_file_must_match_its_name(tmp_path):
    res = run_check(zone_dir(tmp_path, lambda z: None, name="zone-SE4.json"))
    assert res.returncode != 0
    assert "zone must be 'SE4'" in res.stderr
