# Browser feedback loop

> This is the *agentic* browser test: Jev decides which control to operate, and
> the harness then verifies the result independently. It needs a TypeSafe key
> and Chrome remote debugging, and it costs money to run.
>
> For deterministic rendering and layout regressions -- camera framing, canvas
> sizing, Retina, Safari -- use `npm run check:ui` from the repository root
> instead. It is free, runs in Chromium and WebKit at two pixel ratios, and is
> the check that belongs in CI. The two are complementary: this one answers
> "can an agent drive the interface", that one answers "does the interface
> render correctly".

This tool pins [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) and uses Jev to exercise Dogfight Bench in a real Chromium tab.

The loop is deliberately split into three responsibilities:

1. The upstream agent observes visible DOM controls once per cycle and asks Jev for an operation plus compatible speculative targets in one request.
2. Ordinary browser code validates the indexed target and executes exactly one action.
3. This package independently checks the simulator's exported read-only state, exercises the canvas zoom gesture directly, and saves screenshots plus a JSON summary.

Jev never receives screenshots, selectors, JavaScript, or API credentials. A Jev `DONE` answer is not considered a passing test without the independent state checks.

## Setup

From this directory:

```bash
uv sync
uv run browser-harness --doctor
```

Put the TypeSafe credential in the repository-root `.env.browser-feedback` file:

```dotenv
TYPESAFE_API_KEY=...
```

Start Dogfight Bench in another terminal, then run:

```bash
uv run --env-file ../../.env.browser-feedback browser-feedback
```

Artifacts are written under `artifacts/browser-feedback/`, which is ignored by Git.

## Checks

```bash
uv run ruff check .
uv run pyright
uv run pytest
```
