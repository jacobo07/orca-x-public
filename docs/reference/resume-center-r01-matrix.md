---
title: Resume Center vs r01 — difference ledger
status: live
covers: [resume-center, r01, w4, visual-reference, responsive]
reference: docs/visual/generated/resume-center/resume-center.full.desktop.at-rest.r01.png
reference_sha256: 6c7f0b52de6d84980156850be32a478b7ab3ac97552ddc143e5975404b44afc9
reference_size: 1512x1042 (a generated image with its own black margin: compared by structure and proportion, not pixel identity)
measured_at: 9a6449085
---

# Resume Center vs r01 — difference ledger (W4)

Every visible r01 element, judged against the real app captured by
`tests/e2e/resume-center-r01-reality.spec.ts` at a 1512×1042 content area, light and dark, and
swept from 1512 to 800 px. A row changes class only on new evidence from that spec or a successor;
an element added to r01 later is added here before it is built.

Classes: **ALIGNED** · **REAL-DATA** (same structure, the desk's own values) · **EXTENSION** (a real
capability r01 does not draw) · **INTENTIONAL** (a deliberate product difference, reason given) ·
**UNSUPPORTED** (no producer exists; building it belongs to the wave named) · **OPEN** (visual debt).

## Header and shell

| r01 element | Orca at 1512 | Class | Producer / reason |
|---|---|---|---|
| Global left nav, full destination list | Resume Center variant: Back + global destinations, Knowledge/Audit disabled "Not available yet" | INTENTIONAL | Owner ruling 2026-10-02 (workspace-convergence §2.A) |
| "System · All systems operational" footer | absent | UNSUPPORTED | no health producer answers "all systems"; claiming it would be invented |
| User chip (avatar, name, role) | absent from this column | UNSUPPORTED | owned by the global shell, not this page; no role producer |
| Top bar search, host switcher | menu bar + breadcrumb | INTENTIONAL | global shell, outside the Resume Center surface |
| Breadcrumb Workspace › Resume Center | same | ALIGNED | |
| Greeting with first name | same; name omitted without a cloud profile | REAL-DATA | `orcaProfileAuthStatus.cloud.displayName` |
| "You had N windows open with M active sessions" | "N windows with M sessions on your desk · K running" | ALIGNED + EXTENSION | window topology (omitted when unrecorded, never 0), desk totals, host-listed sessions |
| "Last close: today 14:22 · saved automatically" | absent here; save time lives in Current snapshot as "Desk saved …" | UNSUPPORTED | the profile file's write time says when, not why; no close-cause producer |
| Hero: Resume all (primary) | same, primary | ALIGNED | wake admission, one at a time |
| Hero: Restore layout only | same, for the selected workspace | INTENTIONAL | a desk-wide layout restore has no owner |
| Hero: More options (snapshots, settings) | **Snapshots** for the selected workspace | INTENTIONAL | the only option with a real effect; a one-item menu is chrome |
| — | **Open in** for the selected workspace (the user's Open-in apps, Cursor among them) | EXTENSION | W5: the sidebar's `shell:openInExternalEditor` authority, reached from here; local and SSH, refused for a runtime host or an unknown folder |
| Tabs Orca X / Cursor / Others | absent | UNSUPPORTED | no producer sees a Cursor window: the Cursor hook reports only from inside an Orca pane (no `ORCA_PANE_KEY` outside), and only agent turns |
| Search sessions | same | ALIGNED | metadata only, never terminal content |
| Sort dropdown | "By window" / "Most recent" | ALIGNED | the two sorts the model has |
| List / grid toggle | absent | UNSUPPORTED | no grid layout exists |

## Workspace card

| r01 element | Orca at 1512 | Class | Producer / reason |
|---|---|---|---|
| App prefix in title ("Orca X · …") | name only | UNSUPPORTED | no app-detection producer (see Tabs) |
| Name, path | same | ALIGNED | desk identity (`describeWorkspace`) |
| Branch chip | same; absent for folders | ALIGNED | `Worktree.branch` |
| Host chip ("GEX44") | shown for non-local hosts only | REAL-DATA | desk host id |
| — | window chip ("Window 1") | EXTENSION | recorded window topology |
| — | Mission Brief chip, selects the row | EXTENSION | W2: `hasMissionRecords` probe |
| Relative time, session count, collapse | same | ALIGNED | `lastVisitedAt` (omitted when unrecorded), desk counts |
| Large left screenshot | first pane's last recorded screen | REAL-DATA | daemon history, never a window capture; stacks above the rows below `lg` |
| Row monogram | same; agent icon for agent tabs | ALIGNED | |
| Row Agent name + role ("Hermes · General purpose") | tab title + agent type | UNSUPPORTED | tabs are not bound to Agent records |
| Row counts (terminals / files / agents) | pane count per row; open files and agent tabs on the workspace line | INTENTIONAL | files and agent tabs are owned per workspace, not per tab |
| Row status | StatusMark + word | EXTENSION | host-listed residency; UNKNOWN hollow |
| Three inline thumbnails | up to three, lazy | ALIGNED | load only when their strip intersects; idle while hidden below `lg` or below the fold (W4 e2e) |
| Row Resume button | shown only when the row is not running | INTENTIONAL | a running row needs no wake |
| Row chevron on the right | expand chevron on the left | INTENTIONAL | it expands the row's labelled previews; position follows the row's reading order |

## Right column

| r01 element | Orca at 1512 | Class | Producer / reason |
|---|---|---|---|
| — | Workspace nav + compact Mission Brief above the card | INTENTIONAL | Owner ruling §2.A |
| Current snapshot title | same | ALIGNED | |
| Snapshot thumbnail | absent | UNSUPPORTED | no whole-desk capture exists |
| "Today, 14:22" | "Desk saved 5 min ago", exact time on hover | ALIGNED | profile file mtime; `never` / `unknown` kept apart (W3) |
| "Automatic (app close)" | absent | UNSUPPORTED | no cause producer (see header) |
| Workspace / session / terminal counts | same + windows, running, sleeping, unknown | ALIGNED + EXTENSION | desk totals |
| Workspace names | same, whole desk regardless of search | ALIGNED | unfiltered desk rows (W3) |
| Quick actions card | absent | INTENTIONAL | Resume all / Restore duplicate the hero; "View previous snapshots" = Snapshots; "Create new snapshot" is the dialog's Save; "Select sessions…" has no producer |
| App detection card, Configure integration | absent | UNSUPPORTED | no app-detection producer; the one integration that exists is "Open in", in the hero |
| Tips card, "don't show again" | tip with "Dismiss" | INTENTIONAL | dismissal is per visit; the label does not promise permanence |

## Themes and widths (W4, `9a6449085`)

- **1512×1042 light and dark:** every hero action reachable; dark surfaces, borders and secondary
  text coherent; StatusMark meaning unchanged across themes (its computed fill/ring parity is pinned
  by `workspace-navigation-convergence.spec`).
- **Sweep 1512 → 800:** fixed in `9a6449085`. Hero actions wrap (Snapshots and Refresh had been drawn
  off-screen at ≤1024 and under the context column at 1280–1366); row facts never wrap or overlap;
  the large preview stacks below `lg` instead of starving the rows.
- **OPEN visual debt:** none blocking at the time of measurement.

## Evidence (W4)

- **Windows** at `9a6449085`: `resume-center-r01-reality.spec` PASS (captures in
  `test-results/resume-center-r01-reality-*`). Window sizes are set with `setContentSize`, which
  rounds (1366 → 1367), so widths are judged ±2 px.
- **GEX44** at `9a6449085` (`/home/kobii/conv-w2-run-9a6449085/summary.txt`): r01-reality,
  resume-center, snapshots, mission-discovery, resume, restore-no-wake, mission-brief (2),
  workspace-navigation-convergence, global-nav-shell-stability all PASS.
  `project-working-set-restore-surface` FAILS at `:330` on Linux only: its fixture launches the
  Windows-only `shell:cmd.exe` profile, which Linux correctly judges `not-restorable`. The route to the
  dialog passed. This is a platform difference in the fixture, not a product defect, and it is listed as debt.
- **Real-app mutants, GEX44** (`mutants.txt`; each one planted, built, run, restored and verified):

  | mutant | caught by | reason in the red |
  |---|---|---|
  | inline thumbnails always enabled (`enabled={stripSeen}` → `enabled`) | r01-reality `:180` | "inline snapshots fetched while hidden at 900px" |
  | hero group without `min-w-0 flex-wrap` | r01-reality `:239` | Refresh outside viewport at 1024, covered by a button at 1280 |
  | `WorkingSetsDialog` mounted twice (Sidebar + root) | working-set `:170` via `:279` | strict mode: 2 `working-sets-dialog`, before the Linux-only red at `:330` |

  The zero-window greeting mutant is covered only by the `greetingWindowCount` unit.

## Evidence (W5, Open in)

- Unit `resume-center-open-in.test.ts` 5/5 (local, SSH `ssh:<id>` → `connectionId`, runtime refused,
  missing / unknown / pathless refused, unparseable host refused); mutants ssh→local, runtime→local,
  identity check dropped: all red.
- Windows `resume-center-open-in.spec.ts`: the main handler of `shell:openInExternalEditor` is
  replaced by a recorder; selecting the NON-auto-selected of two repos and choosing Cursor records
  exactly `{ path: <that repo>, command: 'cursor', connectionId: null }`. Real-app mutant "hero takes
  the auto-selected row" CAUGHT (asked for `…second…`, expected `…first…`).
- `resume-center-r01-reality.spec` sweeps the fourth hero action at 1512×1042 light/dark and
  1512 → 800: PASS on Windows.
