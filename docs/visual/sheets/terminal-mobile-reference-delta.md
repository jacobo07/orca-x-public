# Mobile terminal: reference vs shipped screen

Reference: `docs/visual/generated/terminal/terminal.session.mobile.at-rest.r01.png` (registry
`terminal.session.mobile.at-rest.r01`): `truth: target`, `candidate`, ChatGPT-generated, 941x1672.
It sets composition and hierarchy only. It is not a pixel or copy source: the body text carries
generated typos, and pixel values come from `mobile/src/theme/mobile-theme.ts`, never from this image.

Shipped screen: `mobile/app/h/[hostId]/session/[worktreeId].tsx` (read 2026-10-19 on rb-live).

## Deltas, by region

| # | Region | Reference | Shipped | Kind |
|---|---|---|---|---|
| 1 | Header, left | ☰ menu + Orca logo | ‹ back to worktrees (`:4356`), worktree name + status line (`:4365`) | layout |
| 2 | Header, centre | **Cambiar host** and **Runtimes** pickers | none in the session | new capability |
| 3 | Header, right | search + ⋮ | files, source control, ⋯ (`:4386-4409`) | layout |
| 4 | Identity line | ● `C1 · GEX44 ~/claude-power-pack` above the output | host/state in the header meta row, no cwd | layout + data (cwd) |
| 5 | Output | rounded card, monospace, fold caret ˅ on an agent block | full-bleed xterm | open question, see below |
| 6 | Composer | **+** left, field, expand ⤢, send ↑ | field, attach/dictation, send ↑ (`:4959-5013`) | layout |
| 7 | Field hint text | "Escribe un comando…" | literal "Type a command…" (`:4974`) | copy/locale |
| 8 | Key row | Ctrl · Esc · Tab · … ‖ A · ← ↓ ↑ → | configurable accessory row (`terminal-accessory-keys.ts:202`, user layout in `terminal-accessory-layout.ts`) | default order + styling |

## Open question (decides slice 4)

Row 5: the fold caret and the bullet formatting are a rendered agent transcript, not terminal
cells. Either the card restyles the xterm (cheap), or it is a structured agent view beside the
terminal (a different surface, near native chat). It is not decided here.

## Proposed slices, in order

1. **Composer + key row** (rows 6-8): + on the left, an expand affordance, the reference's
   default key order. A layout the user already saved in `terminal-accessory-layout` is left
   untouched. The hint text follows whatever locale mechanism mobile already has; none is invented.
2. **Header + identity line** (rows 1, 3, 4): the existing actions move behind ⋮/search without
   losing any (capability-preserving compaction). Adds the identity line with the cwd the session
   already knows.
3. **Host and runtime pickers** (row 2): a host switch inside a session is a new flow, with an
   SSH and mixed-version story to settle first. It gets its own spec.
4. **Output card** (row 5), after the open question is answered.

Done gate for each slice: a screenshot from the real mobile app compared against this reference,
registered as `truth: current`. A passing suite is not that gate.
