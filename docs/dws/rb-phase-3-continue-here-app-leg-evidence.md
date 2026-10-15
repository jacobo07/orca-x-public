# Phase 3 Continue here: real-app leg (row 70)

## Plane

REAL-APP / STORE-SEEDED-HOST. The real Electron app on GEX44, driven by Playwright through
`orcaPage` under xvfb, from an e2e-mode build. GEX44 has no second host, so the target host's
project setup, its workspace and its SSH availability are written into the renderer store by
`tests/e2e/helpers/working-set-continue-seed.ts`. Source and target are one machine. Every outcome
is read from the dialog's `data-*` handles, not from the store.

## Command

Build and run both at HEAD `83db534b45c8a6f3f4b7d2b91452474c5d0a2585` (no source file newer than
the build):

```
VITE_EXPOSE_STORE=true node_modules/.bin/electron-vite build --mode e2e
SKIP_BUILD=1 xvfb-run -a -s "-screen 0 2560x1600x24" node_modules/.bin/playwright test \
  --config tests/playwright.config.ts --project=electron-headless --workers=1 \
  tests/e2e/project-working-set-continue-here.spec.ts
```

Build exit 0, run exit 0.

## Result

Lines copied from the run log (`CONTINUE70_*`):

```
CONTINUE70_OFFER PASS
CONTINUE70_PANES ["unavailable/nothing-runnable","restart/relaunchable","unavailable/not-confirmed"]
CONTINUE70_RESTORED PASS
CONTINUE70_UNVERIFIED-AND-DOWN PASS
CONTINUE70_TARGET-MISSING PASS
  4 passed (2.3m)
```

The pane table is sorted by random leaf id, so its order differs between runs; an earlier green run
printed the same three pairs in the order not-confirmed, relaunchable, nothing-runnable.

### Red-first record

The RESTORED leg was run with the target workspace seed withheld (a literal id and no store
write). It failed, then was restored byte-identical and run green:

```
CONTINUE70_RESTORED FAIL expect(locator).toHaveAttribute(expected) failed
    Expected: "restored"
    Received: "continue-target-unavailable"
  1 failed
```

Recorded twice: in the first red run (45s, detail line coloured by ANSI before stripping was
added) and again at the final HEAD (45.0s).

### Mutant

The UNVERIFIED leg seeded `connected` instead of `absent`. It failed with `Expected: "refused"`,
`Received: "restored"`, and the spec was restored byte-identical.

## What it proves

- The Continue here offer appears only once another host holds a ready setup of the project (the
  absent case is checked with the dialog proven present first).
- Continue onto a connected host with a seeded workspace returns `restored`, and the dialog's pane
  table equals the shared planner's answer for the same manifest. The table is varied (restart,
  two kinds of unavailable), so a constant answer would not match.
- Restored rows are sleeping: every target tab is dormant with reason `working-set-restore`, none
  has a process, the main-process PTY session list equals its baseline, and the source workspace
  is unchanged.
- An unmeasured host (no SSH state) and a disconnected host both refuse and apply nothing (zero
  rows, unchanged tab counts in every workspace). The two are told apart: neutral tone with one
  sentence versus problem tone with another. A connected run on the same app is the control.
- A setup whose workspace is not in the store gives `continue-target-unavailable`, changes
  nothing and synthesizes no key. Seeding the workspace and clicking again gives `restored`.

## Not covered

- No two-host reattach to a live remote PTY. Nothing here connects two machines, and no row is
  opened (sleeping rows are asserted, per the deviation from D-15).
- No real SSH connection: availability is a seeded store value.
- No folder-workspace leg in the app; that is pinned hermetically in 03-01 and 03-07.
- The refused arm renders no pane rows, so the planner's `host-unverified` pane reason is not a DOM
  fact; it is pinned hermetically in 03-01 and 03-07.
- Executor-authored non-English strings are unreviewed.

## Leg state

`READY_FOR_LIVE: continue-here-in-app`

Live check still owed: seed a two-host run file, connect the target host, run Continue here, open
a restored row and observe a reattach to the live PTY.
