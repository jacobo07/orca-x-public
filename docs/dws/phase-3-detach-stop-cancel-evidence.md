# Phase 3 Detach / Stop / Cancel - mutation drill evidence

Plane: LOCAL (Windows host, `C:\Users\User\Apps\orca-dws-wt`, branch `orca-x/distributed-workstation`, base HEAD `4dd851f3e`). Free memory before the series: 3.85 GB (above the 2 GB local floor, so no GEX44 run). Tier: LOCAL-HOST (scoped vitest only; not a real-app run).

Procedure per drill: target clean against HEAD (`git diff --quiet` exit 0); baseline SHA-256; plant by exact-once byte replace (refused unless the old string occurs exactly once); planted SHA-256 must differ (positive control); scoped vitest; restore by writing the saved bytes back; restored SHA-256 must equal baseline and `git diff --quiet` must exit 0 before the next drill.

| Drill | Target | Plant | Baseline SHA | Planted SHA | Named test | Observed failing assertion | Controls green | Restored = baseline | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| M1 | rpc/core.ts socketAbortSignalsFor | always hand back the socket signal as `signal` | 93E789D988E6 | 69FE6E2DE038 | effect-class-registry 'dispatch withholds the socket signal from a launch method...' and 'dispatchStreaming applies the same split...' | AssertionError: expected AbortSignal { aborted: false } to be undefined | yes (characterization file 5/5 green incl. C and D) | yes | CAUGHT |
| M2 | rpc/methods/agent-session.ts | remove `effect: 'launch'` from terminal.createAgentSession only | 9845638F17B2 | 7F8F754C5C03 | effect-class-registry 'flags exactly the three launch RPC methods' (+ 'station control') | AssertionError: expected [ 'session.tabs.createTerminal', ...(1) ] to deeply equal [ ...(2) ] | yes (8 other cases green) | yes | CAUGHT |
| M3 | rpc/methods/agent-session.ts createAgentSession handler | destructure waitSignal and pass it as the caller `signal` | 9845638F17B2 | BB976D5417AA | characterization case A 'closing the requesting socket does not abort an in-flight terminal.createAgentSession' (B and E also red) | AssertionError: expected [ 'clientId', 'clientKind', 'signal' ] to not include 'signal' | yes (case C and control D green, 2 passed) | yes | CAUGHT |
| M4 | orca-runtime.ts createAgentSession | guard throwing client_disconnected when caller.signal.aborted, before the operation key | CB4E00481ABB | A2AF5F1F277C | orca-runtime-agent-session-detach 'an already-disconnected caller does not stop createAgentSession...' | promise rejected "Error: client_disconnected" instead of resolving | yes (2 other cases green incl. onClientDisconnected) | yes | CAUGHT |
| M5 | rpc/core.ts socketAbortSignalsFor | over-correction: return no signal for every method | 93E789D988E6 | 96149DEEE60D | characterization control D 'closing the requesting socket still aborts an in-flight terminal.wait' + registry plain-method/streaming delivery | control D: Error: timed out waiting for condition; registry: expected undefined to be AbortSignal { aborted: false } | yes (case A green) | yes | CAUGHT |
| M6 | remote-runtime-pty-transport.ts disconnect() | send terminal.close for the transport handle via closeRemoteTerminal | D9CEE2C1CFDE | 15B45CBA92B1 | detach-sends-no-stop 'an attached transport sends no stop-class RPC on disconnect' (+ on destroy) | AssertionError: expected [ 'terminal.close' ] to deeply equal [] | yes (3 of 5 green, incl. positive control) | yes | CAUGHT |
| M7 | rpc/methods/workstream-cancel.ts handler | take ctx and call runtime.stopTerminalsForWorktree before refusing | 1DC6E7032A32 | 9D9F50122AE5 | workstream-cancel 'refuses with workstream_authority_unavailable naming uwcp.control/1 and reaches no stop effect' (+ runtime-scope device) | reply no longer the authority refusal: the stop spy threw 'stop effect reached' (expected { ok: false, error: {...} } to match) | yes (4 of 6 green: old-host, invalid-params, Stop-routing) | yes | CAUGHT |
| M8 | rpc/methods/workstream-cancel.ts handler | return a success object instead of refusing | 1DC6E7032A32 | D4E7215379BD | workstream-cancel 'refuses with workstream_authority_unavailable...' (+ runtime-scope device) | AssertionError: expected { id: 'req_1', ok: true, ... } to match object { ok: false, error: {...} } | yes (invalid-params case green) | yes | CAUGHT |
| M9 | shared/execution-effect-refusals.ts | append terminal_stop_pty_set_mismatch to the Cancel list | 2D0751F1CBDD | CCC402FC7FE5 | execution-effect-refusals 'freezes the Cancel Workstream vocabulary...' and 'keeps the two vocabularies disjoint...' | expected [ ...(2) ] to deeply equal [ 'workstream_authority_unavailable' ]; expected [ 'terminal_stop_pty_set_mismatch' ] to deeply equal [] | yes (2 of 4 green incl. source-presence) | yes | CAUGHT |
| M10 | rpc/core.ts socketAbortSignalsFor + rpc/methods/agent-session.ts createAgentSession handler (together; nothing in orca-runtime.ts) | pre-Phase-3 delivery restored: always hand back the socket signal as `signal`, and forward ctx `signal` as the caller `signal` | core 93E789D988E6 / agent-session 9845638F17B2 | core 69FE6E2DE038 / agent-session 3915943F7BF7 | characterization case E 'a runtime that refuses a disconnected caller still completes a create whose socket closed mid-flight' (A and B also red on the `signal` key, not the stated reason) | received req_create_e reply `{ ok: false, error: { code: 'runtime_error', message: 'client_disconnected' } }` where `ok: true` was expected | yes (case C and control D green, 2 passed) | yes (both files) | CAUGHT |
| M11 | orca-runtime.ts createMobileSessionTerminal | abort pre-check throwing client_disconnected at the top of the method | CB4E00481ABB | DCE70CC303CF | orca-runtime.test.ts -t 'still reaches the renderer after its client disconnects' | AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times | not run in this drill (the -t filter selected one test; the sibling control was not run) | yes | CAUGHT |

M11's plant is my reading of "the site-5 pre-check" (top-of-method abort guard); the plan did not specify the exact lines, so this proves the guard the test pins, not the historical text.

## Dirty-path bracket

Before and after the series the sorted `git status --porcelain` set was identical (untracked only: `.claude/`, `.pp-capabilities`, `.pp-pending-spec.json`, `LEARNINGS_PENDING.md`). No tracked file modified.

## Post-drill green run

Scoped set of the plan's verify command 2: 16 test files, 191 tests, all passed, exit 0.

## Mobile-scope `forbidden` test (03-04 note)

Not touched by these drills. Its RED remains vacuous as 03-04 recorded (an unregistered method is also forbidden to mobile); no drill here proves it falsifiable. Not expanded in scope.

## Product-leg status

NOT RUN. The GEX44 serve still runs pre-Phase-3 code; the host-side Detach guarantee is proven by tests (LOCAL-HOST tier), not yet redeployed, and `tests/e2e/dws-remote-continuity.spec.ts` was not rerun at the Phase 3 SHA. Cancel Workstream remains ABSENT (UWCP `uwcp.control/1` not built); `workstream.cancel` only refuses.