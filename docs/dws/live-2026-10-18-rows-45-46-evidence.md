# Rows 45 and 46: agent-turn leg through the GEX44 serve (2026-10-18)

Plane: laptop Orca desktop (Playwright, electron-headless, out/ from 2026-10-17) paired through an SSH
tunnel to `orca-dws-serve` on GEX44 (unit `WorkingDirectory=/home/orca-svc/dws-p2/3266e1a`, MainPID
3357463 before and after every run, never restarted or redeployed).

## What unblocked it

The Owner logged in Claude interactively as `orca-svc` on GEX44 (`claude auth status`: loggedIn,
claude.ai). Codex was not logged in, so no codex leg ran.

## Controls before the sweep

`node config/scripts/dws-offload-workload.mjs agent --nonce <n>` as orca-svc in the service checkout:

| nonce length | matched |
| --- | --- |
| 16 hex | 2/4 |
| 8 hex | 4/4 |

A miss was a real turn (exit 0) whose reversal of the nonce was wrong, so the classifier was right and
the nonce was the defect: the spec now uses 8 hex characters (b978e15d82).

## Runs

Launcher: `%LOCALAPPDATA%\orca-dws-p2\runs\offload-4{a,b}-launch.ps1` (offload-3d's launcher with the
repo, RunId and `-Legs test,build,agent -AgentKind claude` changed). Raw NDJSON/capture stay there.

- **offload-4a** (with `-BaselineManifest baseline-2`): agent PASS (peak 322.43 MB), build PASS,
  test UNJUDGED (no LEG-START), then the spec refused: NOT_COMPARABLE, only
  `src/main/runtime/runtime-rpc-websocket-bind-host.test.ts` differs between the baseline sha
  and 3266e1a (the wrapper matches). Cause of the unbound test leg: the terminal preview is a tail,
  and vitest's output pushed LEG-START out of it before the 3 s poll read it.
- **Fix:** the remote spec pipes each leg through `grep --line-buffered DWS-P2-LEG`, so the preview
  only holds the markers.
- **offload-4b** (no baseline, comparability UNJUDGED by design): `PLAYWRIGHT_EXIT=0 RUN_EXIT=0`,
  every leg bound by LEG-START. Machine record: `docs/dws/live-2026-10-18-offload-4b.json`.

| leg | childPid | ms | remote proof | peak RSS |
| --- | --- | --- | --- | --- |
| test | 3555197 | 6029 | PASS | 603.60 MB |
| build | 3555525 | 958 | PASS | 797.37 MB |
| agent (claude, `matched`) | 3555988 | 4235 | PASS | 322.56 MB |

Laptop sampler (61 samples, desktop subtree 39, leg window covered): vitest, tsc, claude,
workload-wrapper and nonce families 0. One `codex.exe` (35.29 MB, one sample) was a child of the Orca
desktop under test, created at 10:13:52Z, before the first LEG-START at 10:14:17Z: the desktop's own
agent discovery at startup, not the agent leg, and disclosed rather than counted.

## Verdict

- Row 46 (remote process tree): PASS. All three legs are bound to their own child pid and chain to
  the serve MainPID.
- Row 45 (before/after MB + process tree): PASS. Rungs 1-3 were met by offload-3d (absence on
  vitest/tsc/wrapper, COMPARABLE, bracket OK at 201.35 MB drift < 954.505 MB peak delta); rung 4, the
  only open one, was claude absence, which is no longer vacuous: a real claude turn ran remotely and
  no claude process appeared in the laptop's desktop or harness subtree.

## Not covered

- Codex: not logged in as orca-svc, so codex absence is still vacuous.
- No local agent-turn baseline exists, so the agent leg's local saving is shown by its remote peak
  (322.56 MB), not by a laptop before/after delta.
- offload-4b's own comparability is UNJUDGED (no baseline); comparability rests on offload-3d and on
  offload-4a's per-path judgement.
