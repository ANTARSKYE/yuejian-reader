import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_release_versions_are_consistent():
    versions = json.loads((ROOT / "version.json").read_text(encoding="utf-8"))
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    server = (ROOT / "server.py").read_text(encoding="utf-8")
    desktop_js = (ROOT / "assets" / "app.js").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert f'version = "{versions["desktop"]}"' in pyproject
    assert f'VERSION = "{versions["desktop"]}"' in server
    assert f'v{versions["desktop"]}' in desktop_js
    assert f'Reader {versions["desktop"]}' in readme
    assert f'Android {versions["android"]}' in readme
    assert re.fullmatch(r"\d+\.\d+\.\d+", versions["desktop"])
    assert re.fullmatch(r"\d+\.\d+\.\d+", versions["android"])
    assert isinstance(versions["androidCode"], int) and versions["androidCode"] > 0
