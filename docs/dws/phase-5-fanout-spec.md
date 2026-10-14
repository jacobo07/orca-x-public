---
covers: [dws-p5-fanout, x01r2-row-17, node-manifest-fanout]
---
# DWS-P5 fan-out rung: the laptop runtime reads GEX44 through callEnvironment

## Objective
`orca fleet manifest --model-probe-ports <p>` answered by a laptop-local Orca runtime (an isolated e2e
Electron app) that is paired to the GEX44 `orca-dws-serve` through the ssh -L tunnel, returns a GEX44
member (matched by the serve's runtimeId) whose memory / VRAM / disk / resident-model values MATCH an
independent ssh control within the existing tolerances. Evidence lands in
docs/dws/phase-5-node-manifest.{json,md} with rung `fan-out`.

## Scope
In:
- `tests/e2e/dws-node-manifest-fanout.spec.ts` (opt-in, `ORCA_DWS_P5_FANOUT=1`): pair via
  `attachDwsRemoteRuntime`, then a local CLI call against the same app's userData.
- `attachDwsRemoteRuntime` accepts the pairing URL in memory (`pairingUrl`) as well as a file.
- `dws-node-manifest-run.ps1 -FanOut`: no deploy; preflight proves the laptop's `src/` equals the
  deployed sha; step 5 runs the spec; step 6 (gex44-local-caller) is skipped in this mode.
- Control script shipped LF-normalized (fixes the CRLF blind control of 2026-10-14).
- Evidence glue: rung-specific "what it does not prove" paragraph.
Out: any `src/` change; any serve redeploy or restart; the GitLab/mobile clients.

## Constraints
- The pairing URL is a bearer credential: env only (child process), never argv, disk or logs. The e2e
  userData that stores the paired environment is deleted by the orca-app fixture.
- Serve stays up: MainPID before == after, and teardown leaves no tunnel process or listener.
- The laptop runs Electron headless at ~4.7 GB free; one worker, one test.

## Acceptance
1. Runner STEP 5 FANOUT OK and evidence verdict MEASURED, rung `fan-out`, runtimeIdMatchesServe true.
2. Four families judged (MATCH or DIVERGED, never UNJUDGED from a blind control).
3. Negative control: without `-FanOut` the runner still skips step 5 (unchanged behaviour); a member
   lookup by a wrong runtime id yields BLOCKED `product-read` (glue already does this).
4. Teardown OK; serve MainPID unchanged; evidence secret scan passes.

## Rollback
Delete branch `dws/p5-fanout` and worktree `Apps\orca-p5-fanout-wt`. Nothing deployed.
