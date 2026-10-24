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


def test_missing_required_key_fails(tmp_path):
    def breakit(r):
        del r["revisions"][0]["revised_at"]
    res = run_check(make_dir(tmp_path, revisions=breakit))
    assert res.returncode != 0
    assert "revised_at" in res.stderr


def test_missing_file_fails(tmp_path):
    d = tmp_path / "empty"
    d.mkdir()
    res = run_check(d)
    assert res.returncode != 0
    assert "missing" in res.stderr
