from browser_feedback.runner import matches_expected


def test_matches_expected_subset() -> None:
    assert matches_expected({"follow": "red-1", "timeScale": "4", "extra": "ok"}, {"follow": "red-1", "timeScale": "4"})


def test_rejects_mismatch() -> None:
    assert not matches_expected({"follow": "blue-1"}, {"follow": "red-1"})
