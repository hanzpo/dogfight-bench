"""Run bounded Jev browser tasks and independently verify simulator behavior."""

from __future__ import annotations

import argparse
import base64
import json
import os
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol, cast

from jev_ultrafast import Agent  # type: ignore[import-untyped]


class BrowserProtocol(Protocol):
    def evaluate(self, expression: str) -> Any: ...

    def call(self, method: str, **params: object) -> dict[str, Any]: ...

    def observe(self, screenshot: bool = True) -> dict[str, Any]: ...


@dataclass(frozen=True)
class FeedbackCase:
    name: str
    goal: str
    expected_state: dict[str, str]
    exercise_orbit: bool = True


@dataclass(frozen=True)
class FeedbackResult:
    case: str
    passed: bool
    agent_status: str
    elapsed_ms: int
    action_count: int
    actual_state: dict[str, str]
    expected_state: dict[str, str]
    orbit_changed: bool | None
    actions: list[dict[str, object | None]]
    trace_path: str
    screenshot_path: str


SIMULATOR_SMOKE = FeedbackCase(
    name="simulator-smoke",
    goal=(
        "Set BLUE PILOT to BASELINE AI. Follow the RED aircraft. Change the simulation to 4× accelerated speed. "
        "Pause the simulation. Stop only when all four conditions are visibly reflected by the controls."
    ),
    expected_state={"bluePilot": "basic", "follow": "red-1", "timeScale": "4", "simStatus": "paused"},
)

CASES = {SIMULATOR_SMOKE.name: SIMULATOR_SMOKE}


def _read_simulator_state(browser: BrowserProtocol) -> dict[str, str]:
    value = browser.evaluate(
        "(() => { const d=document.querySelector('#app')?.dataset; return d ? "
        "{bluePilot:d.bluePilot||'',follow:d.follow||'',timeScale:d.timeScale||'',"
        "simStatus:d.simStatus||'',camera:d.camera||''} : {}; })()"
    )
    if not isinstance(value, dict):
        return {}
    items = cast(dict[object, object], value)
    return {str(key): str(item) for key, item in items.items()}


def _exercise_orbit(browser: BrowserProtocol) -> bool:
    before = _read_simulator_state(browser).get("camera", "")
    rect = browser.evaluate(
        "(() => { const r=document.querySelector('canvas')?.getBoundingClientRect(); "
        "return r ? {x:r.x,y:r.y,width:r.width,height:r.height} : null; })()"
    )
    if not isinstance(rect, dict):
        return False
    geometry = cast(dict[str, float | int], rect)
    x = float(geometry["x"]) + float(geometry["width"]) * 0.56
    y = float(geometry["y"]) + float(geometry["height"]) * 0.46
    browser.call("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, button="left", clickCount=1)
    for offset in (25, 50, 75, 100):
        browser.call(
            "Input.dispatchMouseEvent",
            type="mouseMoved",
            x=x + offset,
            y=y - offset * 0.35,
            button="left",
            buttons=1,
        )
    browser.call("Input.dispatchMouseEvent", type="mouseReleased", x=x + 100, y=y - 35, button="left", clickCount=1)
    browser.call("Input.dispatchMouseEvent", type="mouseWheel", x=x, y=y, deltaX=0, deltaY=-180)
    time.sleep(0.15)
    after = _read_simulator_state(browser).get("camera", "")
    return bool(before and after and before != after)


def matches_expected(actual: dict[str, str], expected: dict[str, str]) -> bool:
    return all(actual.get(key) == value for key, value in expected.items())


def run_feedback(url: str, case: FeedbackCase, artifact_dir: Path) -> FeedbackResult:
    if not os.environ.get("TYPESAFE_API_KEY"):
        raise RuntimeError("TYPESAFE_API_KEY is required")
    artifact_dir.mkdir(parents=True, exist_ok=True)
    with Agent(url, case.goal, record_dir=artifact_dir, screenshots=True) as raw_agent:
        agent = cast(Any, raw_agent)
        state: dict[str, Any] = agent.snapshot()
        for state in agent.run():
            history = cast(list[dict[str, Any]], state["history"])
            operation = history[-1]["kind"] if history else "observe"
            print(f"{state['elapsed_ms']:>5} ms  {len(history):>2} actions  {operation}  {state['status']}")

        browser = cast(BrowserProtocol, agent.browser)
        actual = _read_simulator_state(browser)
        orbit_changed = _exercise_orbit(browser) if case.exercise_orbit else None
        final_page = browser.observe(screenshot=True)
        screenshot_path = artifact_dir / "final.jpg"
        screenshot_path.write_bytes(base64.b64decode(str(final_page["screenshot"])))

        passed = (
            state["status"] == "done" and matches_expected(actual, case.expected_state) and orbit_changed is not False
        )
        trace_path = artifact_dir / "summary.json"
        history = cast(list[dict[str, Any]], state["history"])
        actions = [
            {
                key: item.get(key)
                for key in (
                    "step",
                    "kind",
                    "action",
                    "text",
                    "probability",
                    "confidence",
                    "latency_ms",
                    "page_changed",
                )
            }
            for item in history
        ]
        result = FeedbackResult(
            case=case.name,
            passed=passed,
            agent_status=str(state["status"]),
            elapsed_ms=int(state["elapsed_ms"]),
            action_count=len(cast(list[object], state["history"])),
            actual_state=actual,
            expected_state=case.expected_state,
            orbit_changed=orbit_changed,
            actions=actions,
            trace_path=str(trace_path),
            screenshot_path=str(screenshot_path),
        )
        trace_path.write_text(json.dumps(asdict(result), indent=2) + "\n", encoding="utf-8")
        return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:5173")
    parser.add_argument("--case", choices=sorted(CASES), default=SIMULATOR_SMOKE.name)
    parser.add_argument("--artifacts", type=Path, default=Path("../../artifacts/browser-feedback/latest"))
    return parser


def main() -> None:
    args = _parser().parse_args()
    result = run_feedback(args.url, CASES[args.case], args.artifacts.resolve())
    print(json.dumps(asdict(result), indent=2))
    if not result.passed:
        raise SystemExit(1)
