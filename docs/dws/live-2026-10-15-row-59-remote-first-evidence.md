# Live remote-first legs 2026-10-15: row 59

## Plane

REAL-TWO-HOST. The Electron app from the e2e build of the `28b881b58` tree on the desktop PC, driven by
Playwright through `orcaPage`; Client B is the paired web client. Real `ssh -L` carrier to a private sshd
in the GEX44 disposable root `/tmp/orca-hwf-p15-20261015T161556Z`; relay fence
`0.1.0+8c1dd6939f31` on both sides. App run with `--lang=en-US` (local, uncommitted, reverted), for the
tab-bar "+" layout defect described in `live-2026-10-15-row-73-host-loss-evidence.md`.

## Command

```
npx playwright test tests/e2e/hwf-two-host-remote-first.spec.ts --config tests/playwright.config.ts \
  --project=electron-headless --workers=1
```

with `SKIP_BUILD=1`, `ORCA_HWF_TWO_HOST=1`, `ORCA_HWF_RUN_FILE`, `ORCA_HWF_PROBE_FILE` (probe lines plus
provisioner `status`), `ORCA_HWF_LOCAL_PORT=61013`. Run files kept OUTSIDE `%TEMP%`: the absence scan
reads `os.tmpdir()`, and `create.txt` / `run.json` carry the seed nonce by design. Two earlier runs
failed test 1 on exactly those two harness files (`HWF_ABSENCE_HIT` on them only), not on app state.

## Result: 6 passed (5.5m)

Lines copied from the run log:

```
HWF_ZERO_REPOS=yes
HWF_PIN=SHA256:Db2DBT8dKtxg037NA/wNzB3ssuOe8YBMoxe8B/4IFm4
HWF_TERMINAL_A host=kobicraft-gex44 pwd=/tmp/orca-hwf-p15-20261015T161556Z/repos/p15-repo
HWF_RELAY_FENCE=match local=0.1.0+8c1dd6939f31 remote=relay-0.1.0+8c1dd6939f31
HWF_ABSENCE verdict=PASS control=found hits=0 files=1956 unreadable=3 unexplained_unreadable=0 capped=false
  ok 1 connects to the owning host and runs a terminal there
HWF_PROBE_WEB_GIT_COMMIT=function
HWF_PROBE_WEB_AGENT_STATUS=present
HWF_PROBE_SSH_AGENT_MENU=claude
  ok 2 probes what the two clients expose on the owning host
HWF_TERMINAL_B host=kobicraft-gex44 pwd=/tmp/orca-hwf-p15-20261015T161556Z/repos/p15-repo
HWF_FS_A=ok
HWF_FS_B=ok
HWF_GIT_A sha=97d6ec52a907f7e66390232d5292c4f0adbcc1fc remote=97d6ec52a907f7e66390232d5292c4f0adbcc1fc
HWF_GIT_B sha=ffcbb3ccf819d2bcf7b0da87a6ea400a5b083659 remote=ffcbb3ccf819d2bcf7b0da87a6ea400a5b083659
HWF_ABSENCE verdict=PASS control=found hits=0 files=224 unreadable=3 unexplained_unreadable=0 capped=false
  ok 3 fs, git and terminal act on the owning host from both clients
HWF_HOOK_A=ok
HWF_HOOK_B=ok
HWF_AGENT_A_LAUNCH=observed provider=claude pid=2619868 cwd=/tmp/orca-hwf-p15-20261015T161556Z/repos/p15-repo new_tab=yes preexisting=0
  ok 4 agent launch and hook status act on the owning host
HWF_RELAY_PID before=2621370 after=2621370
HWF_SHELL_PID before=2622954 after=2622954 count_before=1 count_after=1 root_count_before=12 root_count_after=12 cwd_after=/tmp/orca-hwf-p15-20261015T161556Z/repos/p15-repo ptyid_same=true
HWF_TICKS first=1 last=35 gaps=0 max_delta_s=1.005 count=35
HWF_BACKFILL_A outage_ticks=13 seen=13
HWF_B_LIVE_AFTER=yes
HWF_BACKFILL_B outage_ticks=13 seen=13
  ok 5 reconnect keeps the shell
HWF_AGENT_A_LAUNCH=observed provider=claude pid=2640784 cwd=/tmp/orca-hwf-p15-20261015T161556Z/repos/p15-repo new_tab=yes preexisting=1
HWF_ROW_REMOVALS count=0 []
HWF_OUTAGE_HOOK=delivered remote_epoch=1792081504 curl_exit=0 http=204 class=in store_a=true store_b=true
HWF_B_OUTAGE_ROW=seen
HWF_AGENT_PID before=2640784 after=2640784 kind=provider emitter_before=2643904 emitter_alive_after=true
HWF_STATUS_ROW=present relaunched=no before=true
  ok 6 reconnect keeps the agent and the outage hook
```

`preexisting=1` in test 6 is test 4's claude process, still alive in the same root; test 6 measured the
new pid it launched. Teardown `REMAINING=0`, `PROC_COUNT=0`; no local `electron` or `ssh` left.

## What this closes from the row's open legs

- The two-host rerun: RAN, all expected lines present (relay pid equal, `HWF_BACKFILL_A` and
  `HWF_BACKFILL_B` measured 13/13, `HWF_B_OUTAGE_ROW=seen`, status row present through the drop).
- Whether the web client's `terminal.subscribe` path replays the reconnect window to an
  already-subscribed client: measured, `HWF_BACKFILL_B outage_ticks=13 seen=13`.
- The hook posted during an outage: delivered this run (204, both stores). One run does not settle the
  earlier 2-in-5 loss.

## Not covered

- A model turn: the agent is a real `claude` process with no prompt and no credential
  (`OWNER:model-turn-credential`, OD-1). This is the row's remaining blocker.
- A retained stale row for a dead agent after reconnect stays known debt (not exercised).
