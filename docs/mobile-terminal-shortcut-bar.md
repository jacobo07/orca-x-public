---
covers: [mobile-terminal-composer, mobile-terminal-shortcut-bar, sticky-ctrl, terminal-text-size-key, slice-1]
status: approved-decisions
date: 2026-10-19
---

# Mobile terminal: composer and shortcut bar (slice 1)

Reference: `terminal.session.mobile.at-rest.r01` in `config/visual-asset-registry.jsonc` (target,
candidate). Deltas and the other slices: `docs/visual/sheets/terminal-mobile-reference-delta.md`.
Surface: `mobile/app/h/[hostId]/session/[worktreeId].tsx`, command dock (`styles.commandDock`).

## Owner decisions (2026-10-19)

1. **Dictation** stays one tap away: the mic sits inside the field, beside expand. The **+** on the
   left opens attach (photo, or file).
2. **Ctrl is a sticky modifier.** One tap arms it for the next key; a second tap while armed locks
   it; a tap while locked releases it. The fixed Ctrl+C/D/L… keys stay available under "…".
3. **The A key is text size.** It steps through the existing presets (`TERMINAL_TEXT_SCALES`,
   `mobile/src/storage/preferences.ts:42`), the same store pinch and Settings already write.
4. **Everything else goes under "…"**: display mode, live input, Paste, the other built-in keys,
   custom shortcuts and "add shortcut". Nothing is removed.

## Layout

```
[ + ] [ Escribe un comando…            🎤 ⤢ ] [ ↑ ]
[ Ctrl ] [ Esc ] [ Tab ] [ … ]      [ A ] [ ← ] [ ↓ ] [ ↑ ] [ → ]
```

The composer sits above the key row, as in the reference. The keyboard-dismiss key keeps its fixed
position when the keyboard is up (#5106).

## Behaviour

- **Primary row** is fixed: Ctrl, Esc, Tab, …, then A and the four arrows. It does not scroll.
- **"…" sheet** lists, in this order: display mode, live input, Paste (when available), the user's
  visible built-in keys in their saved order, custom keys (long press still deletes), add shortcut.
  The saved layout (`orca:terminal-accessory-layout`) is read, never rewritten, by this change.
- **Sticky Ctrl** applies to the next accessory key (Esc, Tab, arrows, sheet keys) through the
  existing byte builder `buildTerminalShortcutKey` (`terminal-accessory-keys.ts:250`), and to the
  next single printable ASCII character appended at the end of either input, which is sent as its
  control byte instead of being inserted. A character typed mid-field, a paste, dictation or an IME
  commit is inserted normally and leaves Ctrl engaged. A key with no Ctrl form (e.g. a digit) is
  sent unmodified and still consumes an armed (not locked) Ctrl. Armed/locked state is visible on
  the key and announced to screen readers.
- **Offline** (nothing can be sent) Ctrl claims nothing, so local composing keeps every character
  (#6713), and an engaged Ctrl is released because its key is disabled then.
- **A** steps to the next preset and wraps; long press resets to 1×. It goes through the same
  `onTextScaleChange` path as pinch, so the refit and persistence are unchanged.
- **Expand ⤢** opens a full-height multi-line editor seeded with the field's text. Send there
  behaves as the field's send; closing keeps the text in the field.
- **Field hint text** follows the app's existing string handling; this slice adds no i18n layer.

## Out of scope

Header, identity line, host/runtime pickers, output card (slices 2-4). Desktop. The wire: no RPC
changes, so mixed client/host versions are unaffected.

## Structure

The session screen sits about 100 counted lines under its `max-lines` cap (5015,
`mobile/.oxlintrc.json:27`), so the key row moves into new components. The two text fields stay in
the route, because source tests pin their IME, dictation and offline-compose props there:

- `mobile/src/terminal/terminal-sticky-modifier.ts`: pure state machine + byte mapping, with tests.
- `mobile/src/terminal/terminal-text-scale-step.ts`: next/reset preset, with tests.
- `mobile/src/terminal/terminal-shortcut-bar-keys.ts`: which built-ins the row shows.
- `mobile/src/session/MobileTerminalShortcutBar.tsx`, `MobileTerminalShortcutSheet.tsx`,
  `MobileTerminalAccessoryKeyButton.tsx`, `MobileTerminalExpandedComposer.tsx`.
- `mobile/src/session/MobileTerminalInputActions.tsx`: the + (attach) and mic buttons.

Sticky Ctrl claims a typed letter by not writing it into the controlled value, so RN restores the
field and the live-input mirror never sees it.

## Acceptance

1. Pure modules: tests written red first; mutants (lock never releases, Ctrl ignored on arrows,
   wrap missing) each turn a test red.
2. `pnpm --dir mobile typecheck`, mobile oxlint and the mobile suite are no worse than at HEAD.
3. Every control the dock had before is reachable after (inventory test listing each
   accessibilityLabel before vs after).
4. **Done gate:** a capture of the real mobile app (emulator or device) beside the reference,
   registered as `terminal.session.mobile.at-rest.r02` with `truth: current`. Green tests are not
   this gate.

## Rollback

The slice is self-contained in the dock; reverting its commits restores the previous dock. No
persisted format changes.
