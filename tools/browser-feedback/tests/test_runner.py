from browser_feedback.runner import framing_is_centered, matches_expected


def test_matches_expected_subset() -> None:
    assert matches_expected({"follow": "red-1", "timeScale": "4", "extra": "ok"}, {"follow": "red-1", "timeScale": "4"})


def test_rejects_mismatch() -> None:
    assert not matches_expected({"follow": "blue-1"}, {"follow": "red-1"})


def test_requires_centered_aircraft_framing() -> None:
    assert framing_is_centered({"subjectScreenX": "0.5001", "subjectScreenY": "0.497"})
    assert not framing_is_centered({"subjectScreenX": "0.68", "subjectScreenY": "0.50"})
