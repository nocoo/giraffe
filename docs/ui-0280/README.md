# UI 0.28.0 visual evidence

Baseline: `b3ddaa573828aa080620cef17e396403b432bc58` (v0.27.2).
Candidate runtime: `01034e73e538e94d15325679e3f1d08e80b390b0` (v0.28.0).

Chromium captures use the same fixed clock, saved API fixtures and localhost-only
static SPA hosts. No production request or real credential is involved.
The baseline `/refresh` intentionally shows the missing-page state; the restored
layout references historical source at `8f3d819f`.

| Surface          | Before                                          | After                                         |
| ---------------- | ----------------------------------------------- | --------------------------------------------- |
| Refresh Center   | ![Before refresh](before-refresh-desktop.png)   | ![After refresh](after-refresh-desktop.png)   |
| Token settings   | ![Before settings](before-settings-desktop.png) | ![After settings](after-settings-desktop.png) |
| Today activity   | ![Before activity](before-today-desktop.png)    | ![After activity](after-today-desktop.png)    |
| Software Factory | ![Before factory](before-factory-desktop.png)   | ![After factory](after-factory-desktop.png)   |

Desktop captures use a 1440 × 1100 CSS-pixel viewport and light theme.
The corresponding `*-mobile-dark.png` files use 390 × 844 and dark theme.
Refresh detail captures show per-repository progress and the keyboard-scrollable
history table below the initial viewport. All four theme/viewport combinations
are exercised by `tests/e2e/ui-refresh-review.spec.ts`; the committed selection
keeps representative evidence rather than every intermediate run.

Supplementary mobile-dark captures cover the lower sections:
- [Token creation and existing-token management](after-settings-tokens-mobile-dark.png)
- [Factory chart windows and missing-day rendering](after-factory-charts-mobile-dark.png)
- [Refresh dimensions, reasons and history](after-refresh-details-mobile-dark.png)

The browser journey checks that dimension labels and their repository rows do not
overflow at both viewport widths and in both themes. Project-identity journeys
retain the established 24px marks in secondary lists.

Run the full local browser lane with `bun run test:e2e:bdd` after reserving its
fixed ports. The screenshot journey only reads intercepted API fixtures; the
separate refresh-center interaction journey intercepts its cancellation request.
