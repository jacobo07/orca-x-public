---
phase: 18-availability-state-capabilities-and-a-truthful-host-card
plan: 02
status: complete
subsystem: mobile home host card
tags: [mobile, availability, host-card, presenter, gex44]
requires: [18-01 host-availability model, status.get hostAvailability field]
provides: [fetchHomeHostStatus, HOST_CARD_LABELS, presentHostCardAvailability, host card availability/capability lines, GEX44 mobile runner]
affects: [mobile/app/index.tsx, mobile/src/components/MobileHostCard.tsx, 18-03 host-card-claims gate]
tech-stack:
  added: []
  patterns: [one pure presenter over a flat label table, stale-answer-is-no-answer, disposable remote test root with EXIT-trap teardown]
key-files:
  created:
    - mobile/src/transport/home-host-status-fetch.ts
    - mobile/src/transport/home-host-status-fetch.test.ts
    - mobile/src/components/host-availability-presentation.ts
    - mobile/src/components/host-availability-presentation.test.ts
    - .planning/phases/18-availability-state-capabilities-and-a-truthful-host-card/18-gex44-mobile-vitest.ps1
    - .planning/phases/18-availability-state-capabilities-and-a-truthful-host-card/18-gex44-mobile-vitest.sh
  modified:
    - mobile/src/components/MobileHostCard.tsx
    - mobile/src/components/MobileHostCard.test.ts
    - mobile/app/index.tsx
decisions:
  - "An ok status.get whose result is not an object composes as no answer (power and orca unknown), not as a version mismatch"
  - "Test fixtures carry protocolVersion: the presenter applies the same evaluateCompat rule as host-status-gates.ts, so an answer without it reads as version mismatch"
metrics:
  duration: 17m
  completed: 2026-10-27
actuals:
  tokens: 11700
  tasks: 3
  commits: 3
plan_head_before: d019f09f4596efedd1c1c22c3ad0547b3a43f7be
---

# Phase 18 Plan 02: Truthful home host card Summary

The home card now reads its host's `status.get` once per connect, and one pure presenter turns that answer into a
power + orca line and a capability line. Every string comes from the flat `HOST_CARD_LABELS` table. With no current
answer the card reads "Power unknown · Orca unknown". The card still has two controls and nothing that wakes or powers on.

Evidence label: **UNIT (GEX44 disposable root)**. The card on a real phone is still owed to `/gsd-verify-work 18`.

## Commits

| Task | Commit | Subject |
|---|---|---|
| 1 (tracer) | 64bbb2efa | feat(18-02): tracer home status.get -> presenter -> host card line |
| 2 | 4c1beb905 | test(18-02): presenter and status fetch tables |
| 3 | ec259f255 | test(18-02): host card projection cases and full GEX44 gate |

START = d019f09f4. `git diff --stat START..HEAD -- mobile/.oxlintrc.json` is empty, so the max-lines cap was not bumped.
`mobile/app/index.tsx` has 1246 non-blank, non-comment lines before and 1257 after. The cap is 1422.

## GEX44 runs

All runs: host kobicraft-gex44, node v24.21.0, pnpm 12.15.0 (corepack resolves this from mobile's packageManager;
STATE.md's 10.24.0 is out of date), vitest 4.1.9. Every root was `/tmp/orca-phone-p18-<UTC ts>`. Every run printed
`TEARDOWN procs=0 root=absent` and the laptop-side read-only `PROOF ROOT_ABSENT_CONFIRMED`.

| Run | Root | Result |
|---|---|---|
| T1 tracer (test) | /tmp/orca-phone-p18-20261027T170926Z | 2 files, 15/15 passed (the name filter also picks up MobileHostCard.test.tsx) |
| T2 tables (test) | /tmp/orca-phone-p18-20261027T171220Z | 2 files, 34/34 passed. This was the RED capture, and it was already green (see below) |
| T2 mutants (test) | /tmp/orca-phone-p18-20261027T171322Z | 3 failed, 31 passed: stale answer, !ok keeps snapshot, cutover limit |
| T3 full gate, first pass | /tmp/orca-phone-p18-20261027T171524Z | 6 files, 80/80. oxlint 0/0, oxfmt clean, tsc touched 0 (pre-existing 3 not yet listed) |
| T3 card mutants (test) | /tmp/orca-phone-p18-20261027T171638Z | 10 failed, 16 passed: third Wake Pressable, warning tone muted |
| T3 full gate, final | /tmp/orca-phone-p18-20261027T171720Z | 6 files, 80/80. oxlint 0/0, oxfmt clean, tsc touched 0, pre-existing 3 named |

The first T1 attempt failed on the laptop before any remote root existed: `tar.exe` resolved to MSYS tar from a Git Bash
parent. The ps1 now calls `%SystemRoot%\System32\tar.exe`.

### Full gate per file (Task 3, Mode full)

| File | Tests | oxlint | oxfmt | tsc errors in file |
|---|---|---|---|---|
| src/components/MobileHostCard.test.ts | 16 passed | clean | clean | 0 |
| src/components/MobileHostCard.test.tsx | 10 passed | clean | clean | 0 |
| src/components/host-availability-presentation.test.ts | 28 passed | clean | clean | 0 |
| src/transport/home-host-status-fetch.test.ts | 6 passed | clean | clean | 0 |
| src/worktree/home-host-worktree-fetch.test.ts (neighbour) | 7 passed | clean | clean | 0 |
| src/transport/connection-health.test.ts (neighbour) | 13 passed | clean | clean | 0 |
| src/components/MobileHostCard.tsx | (source) | clean | clean | 0 |
| src/components/host-availability-presentation.ts | (source) | clean | clean | 0 |
| src/transport/home-host-status-fetch.ts | (source) | clean | clean | 0 |
| app/index.tsx | (source) | clean | clean | 0 |

Pre-existing tsc errors (3). None is in a touched file, and none is claimed fixed:
- `src/components/pr-sidebar/MermaidDiagram.tsx` TS2307: the generated mermaid engine is absent, because the install skips postinstall.
- `src/terminal/terminal-webview-html.ts` TS2307: the generated terminal engine is absent, for the same reason.
- `src/workspace/mobile-workspace-client.ts(142,69)` TS2366.

Laptop regression: `pnpm run check:workspace-surface-claims` exits 0 (54 surface files, 36 claim sites).

## Presenter exports (`^export` in host-availability-presentation.ts)

`HOST_CARD_LABELS`, `HostCardLabelId`, `HostCardTone`, `HostCardAvailabilityProjection`, `powerLabelId`, `orcaLabelId`,
`presentHostCardAvailability`. There are no others. The label table has exactly two `power.*` keys (awake, unknown), and a test pins that.

## TDD notes

- Task 2: Task 1 had already built the presenter and the fetch, so the new tables were green on their first GEX44 run.
  No failure was invented. To show the tables could fail, three mutants were run: drop the staleness check, raise the
  retry limit to 3, delete the entry on !ok. All three went red, and the sources were restored with `git checkout -- <file>`.
- Task 3: the card cases passed against the Task 1 card. To show they could fail, two card mutants were run: a third
  "Wake" Pressable, and warning mapped to textMuted. They turned 10 cases red, and the card was restored.
  `MobileHostCard.test.tsx` was not changed: it pins no label the projection changed (its assertions are toContain on
  text lines), and its 10 tests pass unchanged.

## Deviations from Plan

1. **[Rule 3 - Blocking] Runner tar resolution.** From a Git Bash parent, `tar.exe` resolved to MSYS tar. The ps1 now
   uses the full System32 path. Commit 64bbb2efa.
2. **[Rule 1 - Bug, runner] CRLF overlay.** The laptop checkout is CRLF (`core.autocrlf=true`), so the .sh strips `\r`
   from the extracted files to match what git commits. Without that, oxfmt would flag every synced file. Commit 64bbb2efa.
3. **Runner clone shape.** The runner uses `git init` + `git fetch <bundle> HEAD` + `checkout --detach FETCH_HEAD`
   instead of `git clone <bundle>`. The two are equivalent, and this form does not depend on the bundle's HEAD symref.
4. **Fixture field.** The tracer and table fixtures add `protocolVersion: MIN_COMPATIBLE_DESKTOP_VERSION`. The presenter
   uses the same evaluateCompat rule as host-status-gates.ts, so an answer without it reads as version mismatch.
5. **Unreadable answer.** An ok answer whose result is not an object is treated as no observation (unknown), not as
   version mismatch. This is tested.
6. **Runner tsc listing.** The .sh prints up to 20 `TSC` lines so that pre-existing errors are named. Commit ec259f255.
7. **Branch allow-list.** The executor's worktree branch allow-list expects `agent-*`. The Owner's set-up branch is
   `mobile/host-availability`. It is not protected, 18-01 committed there too, and the caller named it, so commits went
   there. Nothing was pushed or merged.

## Threat Flags

None. The only new surface is the existing status.get read, which T-18-07..10 already cover. Host strings never reach
Text, and the hostile-snapshot test plus the label-only sweep pin that.

## Known Stubs

None.

## Self-Check: PASSED

- Files: all 6 created files and the 3 modified files are present in HEAD ec259f255.
- Commits 64bbb2efa, 4c1beb905 and ec259f255 are in `git log d019f09f4..HEAD` (count 3).
