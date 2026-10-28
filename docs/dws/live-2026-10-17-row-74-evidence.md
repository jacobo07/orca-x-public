# Live two-host legs 2026-10-17: row 74 (mixed relay versions fail closed)

## Plane

REAL-TWO-HOST. The Electron app built in the laptop worktree `orca-rb-live-wt` (branch `rb-live`),
driven by Playwright through `orcaPage`, connected over real SSH to disposable roots on GEX44
(`/tmp/orca-hwf-p23-*`). Every run: witness unchanged, teardown `REMAINING=0`, `PROC_COUNT=0`.

## Instrument

No relay logs request methods, so the count is the app's own write: `ORCA_E2E_RELAY_METHOD_TALLY=1`
tallies every request and notification at `SshChannelMultiplexer.sendMessage` (`379b49388f`), read
through `electronApp.evaluate`. The current-relay leg is its positive control.

## Why the 2026-10-17 18:40 runs were not enough

The p16 seeds diverge by design (one host commit per side), and the pair service reads the remote
worktree fact, the only `sync.*` request, only for equal tips (`replica-pair-service.ts:148`). So:

- the current-relay control printed `diverged +1/-1` and never reached `sync.replicaFacts` (FAIL);
- the old relay (`5de29754c5`) has no `git.replicaBundle` either: only `relay.status` went out and the
  compare stopped there. Its zero was real but came from that earlier refusal, not from the sync.v1 gate.

The spec now builds an equal-tips pair (fresh clones of both seeds reset to the shared seed root), and
adds a third relay: a build at `35c5b399d0` (`81ce61bc6f^`), which advertises `git.replicaBundle` but not
`sync.v1`. That is the one relay on which the gate decides the outcome. In its bundle `relay.js`, a grep
finds `git.replicaBundle` 2 times and `sync.v1|sync.replicaFacts` 0 times. The same grep finds `sync.v1`
once in the current relay.

## Runs (evidence under `C:\Users\User\Apps\rbl\`)

| Leg | Relay | Evidence dir | Result |
|---|---|---|---|
| current relay (control) | current `out/relay` | `d4-ev-r74cur2-20261017-185046` | `same` exit 0; `sync.replicaFacts` 1; `HWF74_CURRENT_RELAY PASS` |
| between relay, connect | `35c5b399d0` | `d4-ev-r74btw-20261017-185157` | `P23_NO_SYNC_FABRIC_SENT count=0 methods=9` |
| between relay, compare | `35c5b399d0` | same | `unverified (worktree-not-verified-clean)` exit 1; `git.replicaBundleExport` 1; 74 methods, 0 sync./fabric.; `HWF74_GATE_REACHED replicaBundleExport=1` |
| old relay, connect | `5de29754c5` | `d4-ev-r74old2-20261017-185349` | `P23_NO_SYNC_FABRIC_SENT count=0 methods=9` |
| old relay, compare | `5de29754c5` | same | `unverified (relay-too-old)` exit 1; 71 methods, 0 sync./fabric. |

Control vs between relay: same spec, same equal-tips construction, same compare. The current relay got
`sync.replicaFacts` once. The between relay got the identical bundle sequence, and the client refused
`sync.replicaFacts` before sending it. The relation read unknown, never clean.

## Command

```
powershell -File C:\Users\User\Apps\rbl\d4-live.ps1 -Wt <worktree> -Specs tests/e2e/hwf-two-host-mixed-relay.spec.ts \
  -Phase 23 -SeedVerb none -PathEnv none -Grep "current relay" | "old relay"
```

The old-relay legs also need `ORCA_HWF_P23_RELAY_PATH=<relay build>\out\relay`, and the between relay needs
`ORCA_HWF_P23_EXPECTED_WORD="unverified (worktree-not-verified-clean)"` (that word also turns on the
gate-reached assertion).

## Not covered

- `fabric.*`: no production caller sends a fabric method, so its zero is absence. The prefix gate covers it
  only in `ssh-relay-capabilities.test.ts`.
- A relay swapped for an older one mid-session (MethodNotFound, then evicting the capability cache) is
  unit-tested only.
- No gate-removed app build was run live. The current-relay control is what shows the instrument sees a
  sent `sync.replicaFacts`.
