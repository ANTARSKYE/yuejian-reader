import concurrent.futures

from storage import read_json, update_json


def test_concurrent_updates_are_not_lost(tmp_path):
    target = tmp_path / "counter.json"

    def increment(_):
        def apply(value):
            value = value if isinstance(value, dict) else {"count": 0}
            value["count"] = value.get("count", 0) + 1
            return value

        update_json(target, {"count": 0}, apply)

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(increment, range(80)))

    assert read_json(target, {}) == {"count": 80}
