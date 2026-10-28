# Live host-loss leg 2026-10-15: row 73

## Plane

REAL-TWO-HOST. The Electron app from an e2e build (`MODE=e2e`, `VITE_EXPOSE_STORE=true`, no source file
newer than the build) on the desktop PC, driven by Playwright through `orcaPage`, connected over a real
`ssh -L` carrier to a private sshd in the GEX44 disposable root `/tmp/orca-hwf-p23-20261015T155939Z`.
Client B is the paired web client. Built from the `28b881b58` tree, run at `43916026d`, which only adds
matrix and docs edits.

The app ran with `--lang=en-US`. On this PC (Spanish UI, 1366 px window) the terminal strip's
"New terminal" button covers the tab bar's "+" (`tab-bar-new-tab` at x=880, `elementFromPoint` hits
`BUTTON[Nuevo terminal]`), so the forced click of the probe and the agent leg lands on the wrong button and
the menu never opens. In English the "+" sits at x=836, the hit is the "+" itself and the menu opens. That
is a product layout defect, recorded in the hand-off backlog; it does not touch what row 73 measures. The
`--lang` switch was a local, uncommitted test edit and has been reverted.

## Commands

```
node config/scripts/hwf-two-host-remote.mjs new-root --phase 23
node config/scripts/hwf-two-host-remote.mjs create <root> --out create.txt
node config/scripts/hwf-two-host-remote.mjs install-stub <root>
node config/scripts/hwf-two-host-remote.mjs fetch-key <root> --to <dir>
node config/scripts/hwf-two-host-remote.mjs run-file <root> --create create.txt --key <dir>/client_key --out run.json
npx playwright test tests/e2e/hwf-two-host-remote-first.spec.ts --config tests/playwright.config.ts \
  --project=electron-headless --workers=1 -g "probes what the two clients expose"
npx playwright test tests/e2e/hwf-two-host-host-loss.spec.ts --config tests/playwright.config.ts \
  --project=electron-headless --workers=1
node config/scripts/hwf-two-host-remote.mjs teardown <root>
node config/scripts/hwf-two-host-remote.mjs procs <root>
```

with `SKIP_BUILD=1`, `ORCA_HWF_TWO_HOST=1`, `ORCA_HWF_RUN_FILE`, `ORCA_HWF_PROBE_FILE`,
`ORCA_HWF_LOCAL_PORT=61013`. The probe file is the probe test's `HWF_PROBE_*` lines plus the provisioner
`status` lines.

## Result

Probe: `HWF_PROBE_WEB_GIT_COMMIT=function`, `HWF_PROBE_WEB_AGENT_STATUS=present`,
`HWF_PROBE_SSH_AGENT_MENU=claude`; `PROVIDER_CLAUDE=/usr/local/bin/claude`.

Test 1, local app keeps running and the shell is not duplicated (lines copied from the run log):

```
HWF_SHELL_BEFORE pid=2498333 cwd=/tmp/orca-hwf-p23-20261015T155939Z/repos/p15-repo relay=2497523 count=1
HWF_DROP observed_ms=22
HWF_RECONNECT=ladder generation 5475849299058689->5475849299058691 after_restore_ms=5693
HWF_RELAY_PID before=2497523 after=2497523
HWF_SHELL_PID before=2498333 after=2498333 count_before=1 count_after=1 root_count_before=6 root_count_after=6 cwd_after=/tmp/orca-hwf-p23-20261015T155939Z/repos/p15-repo ptyid_same=true
HWF_TICKS first=1 last=35 gaps=0 max_delta_s=1.004 count=35
HWF_BACKFILL_A outage_ticks=13 seen=13
HWF_B_LIVE_AFTER=yes
HWF_BACKFILL_B outage_ticks=13 seen=13
HWF_LOCAL_CONTINUES before=0 after=109
  ok 1 ... local app keeps running through the drop and the shell is not duplicated (1.4m)
```

Test 2, the agent is not duplicated. The first run of this test printed
`HWF_AGENT_A_LAUNCH=NOT_RUN reason=provider-binary-absent` and passed vacuously, because the probe file
lacked the provisioner's `PROVIDER_*` lines. It was rerun alone with them:

```
HWF_AGENT_A_LAUNCH=observed provider=claude pid=2522706 cwd=/tmp/orca-hwf-p23-20261015T155939Z/repos/p15-repo new_tab=yes preexisting=0
HWF_EMITTER pid=2526474 alive=true
HWF_DROP observed_ms=24
HWF_RECONNECT=ladder generation 2285458956869633->2285458956869635 after_restore_ms=5664
HWF_ROW_REMOVALS count=0 []
HWF_OUTAGE_HOOK=delivered remote_epoch=1792080706 curl_exit=0 http=204 class=in store_a=true store_b=true
HWF_B_OUTAGE_ROW=seen
HWF_AGENT_PID before=2522706 after=2522706 kind=provider emitter_before=2526474 emitter_alive_after=true
HWF_STATUS_ROW=present relaunched=no before=true
  1 passed (1.6m)
```

`emitter_alive_after=true` is the first live confirmation of the 900 s emitter tail from `17b6052e3`.

Teardown: `REMAINING=0`, `PROC_COUNT=0`; no local `electron` or `ssh` process left.

## Not covered

- Jobs and background tasks: not exercised live. They hold because no host-loss hook exists in the
  orchestration tree, so nothing re-dispatches on return (evidence of absence, as the row already states).
- The agent is a real `claude` process with no model turn (no credential copied; OD-1).
- The Spanish-locale run cannot reach the "+" menu, see Plane.
