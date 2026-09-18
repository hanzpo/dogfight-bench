from browser_feedback.runner import framing_is_safe, matches_expected


def test_matches_expected_subset() -> None:
    assert matches_expected({"follow": "red-1", "timeScale": "4", "extra": "ok"}, {"follow": "red-1", "timeScale": "4"})


def test_rejects_mismatch() -> None:
    assert not matches_expected({"follow": "blue-1"}, {"follow": "red-1"})


def test_requires_centered_contained_aircraft_framing() -> None:
    centered = {
        "subjectScreenX": "0.5001",
        "subjectScreenY": "0.497",
        "subjectMinX": "0.35",
        "subjectMaxX": "0.65",
        "subjectMinY": "0.42",
        "subjectMaxY": "0.58",
    }
    assert framing_is_safe(centered)
    assert not framing_is_safe({**centered, "subjectScreenX": "0.68"})
    assert not framing_is_safe({**centered, "subjectMaxY": "1.02"})
