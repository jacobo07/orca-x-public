---
phase: 05-composer-copy-paste-visual-product-reality
status: human_needed
verified: 2026-10-26
score: 1/2
human_verification:
  - "Capture keyboard open, keyboard closed, selector open, long names and many runtimes in dark mode on the Android 14 emulator (C:\\Users\\User machine) or a paired phone; register each in config/visual-asset-registry.jsonc as truth current with sha256, labelled emulator when it is one."
---

# Phase 5 Verification

| # | Success criterion | Evidence | Result |
|---|---|---|---|
| 1 | Captures registered as truth current for keyboard open, keyboard closed, selector open and long names | none: no emulator or device reachable from this worker (05-CONTEXT D-03) | BLOCKED (resource) |
| 2 | Pixel values come from mobile-theme.ts, not from the mockups | 0 color literals in the three session style files, each imports mobile-theme; positive control 30 hits in mobile-theme.ts | PASS |

Behaviour behind the goal (one composer, Copy/Paste via expo-clipboard, no duplicate header): dock and
header inventory tests plus the new paste test, 44/44 on GEX44, three mutants CAUGHT.
Plane: unit tests on GEX44 and a static source check. Nothing here is a rendered-pixel claim.
