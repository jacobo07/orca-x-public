---
phase: 05-composer-copy-paste-visual-product-reality
plan: 01
status: partial
completed: 2026-10-26
key-files:
  created:
    - mobile/src/session/use-mobile-terminal-paste.test.ts
---

# Plan 05-01 Summary

## Done
- New `use-mobile-terminal-paste.test.ts` (5 cases): exact clipboard text to the active terminal, no
  Enter, device client attached; bracketed paste wraps and strips embedded `ESC[201~`; target changed
  during the clipboard read sends nothing; un-flushed pending input sends nothing; >256 KiB refused with
  a toast.
- GEX44 run, root /tmp/orca-phone-p5-20261026T154944Z, HEAD 7c268fa18 + this test: 5 files
  (paste, dock inventory, header inventory, output-card source, clipboard image) 44/44.
- Renamed helper `usePasteHarness` (rules-of-hooks lint) re-run in the same root: 5/5.
- Token sourcing: 0 color literals in mobile-terminal-dock-styles, mobile-session-header-styles,
  mobile-session-frame-styles; each imports mobile-theme. Positive control: same pattern finds 30 in
  mobile/src/theme/mobile-theme.ts.

| Mutant | Result |
|---|---|
| P5-M1 (first plant) | INVALID: produced a syntax error, suite crashed; not counted |
| P5-M1b marker stripping removed | CAUGHT by the bracketed-paste assertion, RESTORE_VERIFIED |
| P5-M2 stale-target check removed | CAUGHT ("sends nothing when the active terminal changed"), RESTORE_VERIFIED |
| P5-M3 paste presses Enter | CAUGHT ("sends exactly its text ... without Enter"), RESTORE_VERIFIED |

Teardown: 0 processes, root absent. Local: oxfmt clean, oxlint (mobile config) clean.

## Not done (resource-blocked)
Captures for keyboard open, keyboard closed, selector open, long names and many runtimes, registered as
truth current. Needs the Android emulator on the C:\Users\User machine or a paired physical phone.
