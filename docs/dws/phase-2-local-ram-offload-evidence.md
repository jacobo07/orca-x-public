# Phase 2: Local RAM Offload Vertical Slice — Evidence

This document records, with instrument and observation named beside every claim, the evidence for
DWS-P2-SC2 ("`orca serve` on GEX44 under a service account, bound to loopback, reached only
through an authenticated tunnel, with 'no public port' verified from outside the host"). It is
committed (not under `.planning/`, which is git-excluded) so it resolves on any checkout.

## Verdict vocabulary

Only `PASS` means the claim is proven. Every other verdict is an honest non-proof, not a
euphemism for pass:

| Verdict | Meaning |
|---|---|
| `PASS` | the instrument observed the claim to hold |
| `FAIL` | the instrument observed the claim to NOT hold |
| `UNKNOWN` | the claim was never evaluated |
| `INCONCLUSIVE` | the instrument could not distinguish the claim from its negation (e.g. a positive control failed) |
| `BLOCKED` | evaluation could not proceed (missing precondition, credential, or access) |
| `NOT_APPLICABLE` | the claim does not apply to this configuration |

No pairing URL and no device token appear anywhere in this document; offers are identified only
by `pairingSha12` (first 12 hex characters of the SHA-256 of the pairing URL).

## Identity

| Field | Value |
|---|---|
| Serve SHA (plan-head, this plan's final commit) | `6a6dc48a7abb45ef173a5c25b4adf4d76e119fef` |
| Artifact SHA-256 — build site (GEX44, `dws-gex44-serve-provision.sh build`) | `8b20050b6ca226413dfcbdae74c5a7b0a8162ab3bdd43278fd1d6fe35699fb1f` |
| Artifact SHA-256 — service site (GEX44, `dws-gex44-serve-provision.sh install` preflight `artifact-sha256-match`) | `8b20050b6ca226413dfcbdae74c5a7b0a8162ab3bdd43278fd1d6fe35699fb1f` (`OK`) |
| Artifact SHA-256 — laptop (`Get-DwsArtifact` after scp) | `8b20050b6ca226413dfcbdae74c5a7b0a8162ab3bdd43278fd1d6fe35699fb1f` |
| All three sites identical | yes |
| Electron version | `43.1.0` (observed in the live process tree: `node_modules/.pnpm/electron@43.1.0/...`) |
| systemd unit file SHA-256 (`/etc/systemd/system/orca-dws-serve.service` on GEX44) | `0eef36b97ca97d94cb7bfe64cfe60e2737ad6e5997d6a6ecc178dbd33c296deb` |
| `/home/kobii/orca-x` HEAD before every publish in this plan | `f9a721fda491096b74f0115d78632356e526d096` |
| `/home/kobii/orca-x` HEAD after every publish in this plan | `f9a721fda491096b74f0115d78632356e526d096` (unchanged) |
| Sandbox mode | `no-sandbox` (accepted contingency, T-02-05: Chromium's setuid sandbox helper is incompatible with `NoNewPrivileges=yes`; residual accepted because the headless serve loads no untrusted web content and is loopback-only) |
| `orca-svc` group membership (`id -nG orca-svc`) | `orca-svc` (own group only — no `sudo`, `adm`, or `kobii`) |
| `systemctl is-active orca-dws-serve.service` (end of this plan) | `active` |
| Service checkout | `/home/orca-svc/dws-p2/6a6dc48` |

## Criterion 2: loopback-only serve on GEX44, verified from outside

### CTX-EXP-3 legs (a)-(d) — `Test-DwsNoPublicPort -Port 6791`

| Leg | Claim | Instrument | Observed | Verdict |
|---|---|---|---|---|
| (a) | The listener binds only `127.0.0.1:6791`, owned by the serve's `electron` process running as `orca-svc` | `sudo ss -Hltnp 'sport = :6791'` on GEX44, plus `ps -o user=,comm= -p <pid>` per listed pid | `LISTEN 0 511 127.0.0.1:6791 0.0.0.0:* users:(("electron",pid=504220,fd=77))`; owner `orca-svc electron` | **PASS** |
| (b) | The public address is unreachable at the serve port, from outside | .NET `TcpClient.ConnectAsync` from the laptop to `<gex44-host>:6791`, 3s timeout; positive control: identical probe to `<gex44-host>:22` | direct=`refused`, control=`connected` (control passing rules out "host unreachable" as the reason for the refusal) | **PASS** |
| (c) | The service is reachable only through the authenticated tunnel, not directly | `Invoke-WebRequest http://127.0.0.1:6791/web-index.html` through `ssh -L`; body SHA-256 compared against `sudo sha256sum` of the deployed checkout's own file; then `Stop-DwsTunnel` and the same request repeated | local=`c2afa6d1f917b7b9fd21b7948db59bf7f0d622788fc673bc993d2dfe5124163f`, remote=identical; after `Stop-DwsTunnel`, the request failed (proving the 200 came through the forward, not a laptop-local listener); tunnel restarted afterward | **PASS** |
| (d) | Loopback answers locally on GEX44; the public address is unreachable from GEX44's own vantage point too | `curl -s -o /dev/null -w '%{http_code}'` to `127.0.0.1:6791`; `curl --connect-timeout 3` to `<gex44-host>:6791` | local=`200`, public exit code=`7` (could not connect) | **PASS** |

**`NO_PUBLIC_PORT=PASS port=6791`** (all four legs, observed together in one run against the
plan-head deployment).

### CLI round-trip tracer (Task 1, re-verified at plan-head)

`Invoke-DwsRemoteRoundTrip`: `repo add` + `terminal create --command 'echo DWS-P2-TRACER-<nonce>;
id -un; hostname'` against the tunnel, then polled via `terminal list --worktree ...` (not
`terminal read --terminal <handle>` — see Task 1 deviation #12 in the plan's SUMMARY: each CLI
invocation is a new WS connection / new headless graph owner, and a handle from one process does
not survive into the next, even though the PTY itself does).

`ROUNDTRIP=PASS nonce=de3d8c707aff serveSha=6a6dc48a7abb45ef173a5c25b4adf4d76e119fef
handle=eb0f9d5f-7843-4679-994c-b1c86fcebfa8` — the remote shell's own output contained the nonce,
`orca-svc`, and `kobicraft-gex44`, and the `status` ps-capture showed the shell as a live
descendant of the serve's MainPID under user `orca-svc`.

### Unit tests and mutation drills (Task 2)

Both-pole unit tests for the CTX-EXP-1 pin, in `runtime-rpc-websocket-bind-host.test.ts`:

- `pins the bind host over exposeNetworkByDefault (DWS-P2 pinned)`
- `makes the pairing-time widen a no-op while pinned (DWS-P2 no-op)`
- pre-existing STA-2370 widen test (not pinned) unchanged

Scoped suite (this file + `serve-mode-argv.test.ts`): **33/33 passing**, local plane (free
physical memory 6-8 GB throughout this plan's execution, well above the 900 MB threshold).

Mutation drills (run locally on the trusted worktree rather than GEX44's disposable clone as the
plan's action text specifies — a recorded deviation; see the plan's SUMMARY.md for the full
reasoning: pure TypeScript logic with no OS-dependent behavior, memory was healthy throughout, and
every mutation was reverted and independently verified via `git diff --quiet` before the next
step):

| Drill | Mutation | Result |
|---|---|---|
| (a) | Removed `this.pinnedBindHost !== null` early-return in `ensureNetworkExposure()` | PLANT -> CAUGHT (1 failed: `no-op`; `pinned` stayed green, 32/33 passed) -> RESTORE_VERIFIED (`git diff --quiet` exit 0) |
| (b) | Removed the pin branch in `resolveInitialWebSocketBindHost()` | PLANT -> CAUGHT (2 failed: both `pinned` and `no-op` — the no-op test's own precondition is an initial pinned bind, which drill (b) also breaks; the plan's text requires only `pinned` go red, which it does) -> RESTORE_VERIFIED (`git diff --quiet` exit 0) |

### Named debt

**ND-2 (D2):** `ssh -L` over the Owner's existing `gex44` key stands in for the dispatcher-owned
tunnel until UWCP S5. The matrix entry itself lands in plan 02-06.

### T-02-09 (accepted, not mitigated by this plan)

Other local users on GEX44 can still reach `127.0.0.1:6791` (loopback is host-wide on a
multi-tenant host). Loopback removes network exposure only; device-token auth + E2EE (the
existing `DeviceRegistry`, unchanged by this plan) remain the control against local users.

## Real deployment bugs found and fixed during this plan (summary)

Thirteen deviations were recorded during Task 1 execution (product-code wiring gap, deployment
script bugs, sandbox contingency), documented in full in this plan's `02-01-SUMMARY.md`
(`.planning/`, not committed). Task 3 additionally surfaced and fixed two laptop-tooling bugs that
had never been exercised against the real host before this plan's final verification pass:

- `Get-DwsArtifact` invoked `tar.exe`, which resolved to MSYS2's GNU tar (earlier on this host's
  PATH than Windows' own bsdtar) — its remote-archive heuristic read a Windows drive letter +
  colon as a `host:path` spec and failed every call. Fixed by invoking the Windows-native bsdtar
  at its fixed path.
- `Get-DwsArtifact` then extracted the fetched tarball (whose own top-level entry is `out/`) into
  an already-existing `out` directory, nesting the result as `out\out\...` instead of `out\...`,
  so the CLI's own entry point could not be found. Fixed by extracting one level up, with a
  post-extraction assertion that `out\cli\index.js` exists.

Both are laptop-side tooling fixes; neither affects the product code or the GEX44 deployment
scripts, and both are re-verified in the Identity and Criterion 2 sections above.

## `check-ci-gate-coverage.mjs`

```
node config/scripts/check-ci-gate-coverage.mjs
CI gate coverage: 35 gate script(s) across 32 CI definition(s), 34 invoked, 1 recorded as debt.
exit 0
```

No `check:*` package script whose name mentions documentation exists in this repo at the
plan-head SHA (`check:react-doctor:changed` matched a substring search on "doc" but is unrelated
— it verifies React usage patterns, not documentation).

## `check-dws-completeness.mjs`

```
node config/scripts/check-dws-completeness.mjs
dws completeness: 3 of 76 required row(s) PASS (ABSENT=40 PARTIAL=31 PASS=3 UNKNOWN=2)
Verdict: CONTRACT INVALID
exit 1
```

Red by design (this matrix spans the whole DWS workstream, not just this plan). This plan does
not modify `config/dws-completion-matrix.jsonc` — that entry lands in plan 02-06 — so the row
counts above are identical to (not longer than) this plan's pre-task state.

## Criterion 1 — baseline (plan 02-04)

This section records DWS-P2-SC1: a measured local baseline of the same workload later offloaded
(scoped vitest pair, CLI typecheck, and a one-turn agent leg), run in a terminal of the local Orca
desktop, sampled at ~1 s cadence, with per-family peak/median working set and the positive controls
DWS-P2-SC4's later absence claim depends on (CTX-MEAS-1, CTX-MEAS-3). Verdict vocabulary as defined
above.

### Identity

| Field | Value |
|---|---|
| Baseline checkout SHA (`git worktree add --detach`, this plan's Task 1 commit) | `8c069f7c6033a658be9b69903b448f981530256d` |
| Laptop desktop artifact — smoke-test build (`--mode e2e`, required by `orcaPage`'s `window.__store`) | `4e2f01028267fe145255e747570402b882011598e4d44ca6e3e893c05a36de75` (sha256 of `tar -czf out/`) |
| Note on artifact identity | this `--mode e2e` rebuild is a DIFFERENT artifact from the GEX44 production build recorded in the Identity section above (CTX-CLI-1 requires it for `orcaPage`); Task 1 -> Task 2 added only the three new script/spec files with no product-code change, so the same `out/` build is current for both the smoke test and every baseline sweep below |
| Workload blob hashes (git blob SHA-1, at the baseline checkout SHA) | `config/scripts/check-dws-completeness.test.mjs`=`3a0758c0554c385fd1d9efde4731d92747ece48e`; `src/main/runtime/runtime-rpc-websocket-bind-host.test.ts`=`7aeb1e74b9cf7eafddf0eb760f03a17507151e2e`; `config/tsconfig.cli.json`=`1f4e6c71269d23e57960a515d436fde905b7362a`; `config/scripts/dws-offload-workload.mjs`=`48d599b4c0e7330a6ad2c7e19c9a9dc591d56729` |
| Sampler instrument | `Win32_Process.WorkingSetSize via Get-CimInstance` |

### Sweeps (both reported; baseline-1 rejected, baseline-2 accepted)

Bracket rule (CTX-MEAS-1): a sweep is rejected and re-run when
`|freeBeforeMb - freeAfterMb| >= workloadTotal.peakMb`.

| Sweep | Legs (exit) | Free MB before/after/min (orchestrator) | Drift MB | workloadTotal.peakMb | Bracket | Verdict |
|---|---|---|---|---|---|---|
| baseline-1 | test=0, build=0, agent=1 (`missing`) | 4953.65 / 7282.89 / 2521.05 | 2329.24 | 1023.683 | drift >= peak | **REJECTED** — re-run |
| baseline-2 | test=0, build=0, agent=1 (`missing`) | 6258.7 / 6649.3 / 2723.05 | 390.6 | 956.86 | drift < peak | **ACCEPTED** |

Sampler cadence: baseline-1 `medianMs=1056, samples=377`; baseline-2 `medianMs=1014.5, samples=265`
(sampler-measured `freeMb` for baseline-2: before=6235.52/after=6702.07/min=2723.05 — a few MB off
the orchestrator's own `Get-CimInstance` reading taken at a slightly different instant; both
instruments agree the bracket passes). No baseline-3 was needed. Raw per-sweep NDJSON is kept
outside the repo: baseline-2's is
`C:\Users\User\AppData\Local\orca-dws-p2\runs\baseline-2\samples.ndjson`,
sha256 `68cbcac733afa71807e6848123c8cb1ff5c1165cc08a83da288c3c5fd1613296` (55,020,142 bytes,
267 sampler lines, 0 unreadable).

### Accepted sweep (baseline-2) — per-family peak/median MB, with patterns beside them

| Family | maxCount | peakMb | medianMb | Pattern | Sighted (positive control)? |
|---|---|---|---|---|---|
| `vitest` | 1 | 610.184 | 235.656 | `node.exe`/`node`, commandLine includes `vitest.mjs` | **YES** |
| `tsc` | 2 | 903.657 | 476.104 | `node.exe`/`node` + `typescript/bin/tsc`, or `tsc.exe` | **YES** |
| `claude` | 1 | 233.859 | 214.414 | `claude.exe`, or `node.exe`/`node` + `@anthropic-ai/claude-code` | **YES** (see agent leg below) |
| `codex` | 1 | 12.391 | 12.391 | `codex.exe`, or `node.exe`/`node` + `@openai/codex` | yes, but incidental — this run dispatched only the `claude` agent kind; this small footprint is Orca's own background codex integration, not a measured leg |
| `workload-wrapper` | 1 | 56.195 | 56.156 | `node.exe`/`node` + `dws-offload-workload.mjs` | yes (the wrapper itself) |
| `esbuild` | 0 | 0 | 0 | `esbuild.exe` | no — genuine absence, UNJUDGED for the later offload comparison |
| `indexer` | 0 | 0 | 0 | `rg.exe`, or `node.exe`/`node` + `tsserver` | no — genuine absence |
| `orca-cli` | 0 | 0 | 0 | `node.exe`/`node` + `out/cli/index.js` | no — this baseline used `terminal create`/`terminal read` from inside the already-running desktop's own runtime, not a separate `orca-dev` CLI process |
| `nonce` | 0 | 0 | 0 | any process whose commandLine contains the run's nonce, outside the desktop subtree | no — clean: nothing outside the desktop process tree was contaminated by this run's identity tag |
| `workloadTotal` (sum of all workload families, per sample, peak) | — | 956.86 | 142.305 | — | — |
| `control-surface` (Orca desktop itself — reported separately, never mixed into workloadTotal) | 19 | 1362.035 | 1013.421 | unrecognized-role processes inside the desktop's own subtree | — |

`desktopSubtreeSize=251` distinct pids ever seen inside the Electron main's subtree across the run;
`harnessSubtreeSize=285` distinct pids ever seen inside the Playwright worker's own subtree (these
overlap: the harness dispatches into the desktop).

### Agent leg — UNMEASURED (reproducible failure specific to terminal/PTY dispatch)

Both accepted-relevant sweeps show `agentReply=missing, exit=1` for the `agent` leg when dispatched
via `orca terminal create --command "node .../dws-offload-workload.mjs agent --nonce <n>"`
(baseline-1: `ms=65112`; baseline-2: `ms=10852`). In both sweeps the sampler's own positive control
shows a real `claude` process ran with a genuine memory footprint (baseline-1: `claude.maxCount=2,
peakMb=292` — the `claude.exe` process itself, plus a `rg --no-config --files --hidden <checkout>`
child spawned by Claude Code's own agent loop while gathering context, even for a one-line reply
prompt; baseline-2: `claude.maxCount=1, peakMb=233.859`) — so this is not a missing-binary or
missing-credential failure (T-02-03's mitigation held: the laptop's own existing login was used in
place, nothing copied).

Three standalone reproductions of the identical command
(`node config/scripts/dws-offload-workload.mjs agent --nonce <n>`), run as a direct process spawn
in the same baseline checkout directory (not via `orca terminal create`), all succeeded cleanly
(`exit=0, agentReply=matched`, `ms` 34857/64xxx/34857 across three separate runs, one of them
literally seconds after baseline-2's own PTY-dispatched failure). Per host_rules ("two identical
failures = pivot"): the two terminal-dispatched failures were not retried a third time through the
same mechanism. The evidence supports a reproducible difference between the Orca-terminal/PTY
execution context and a direct process spawn (candidates: environment variables the terminal sets,
working-directory resolution, or something PTY-specific in how the shell wraps the child) — the
exact root cause was not isolated within this plan's time budget, and is left as follow-up work
rather than papered over. Per the plan's own explicit escape hatch (CTX-MEAS-1 / Task 2 action
text): `agentReply=missing` records the agent baseline **UNMEASURED** with this reason. The agent
leg was never faked or substituted.

### DWS-P2-SC1 verdict

The plan's own success bar: "PASS only when at least the test and build legs completed with the
vitest and tsc families sighted." Baseline-2 (accepted sweep): `test` exit=0, `build` exit=0,
`vitest.maxCount=1`, `tsc.maxCount=2` (both positive controls sighted, CTX-MEAS-3 satisfied for the
families the offload comparison plan will need to later claim absent).

**`DWS-P2-SC1 = PASS`** (baseline sweep `baseline-2`; agent leg recorded UNMEASURED, reason above;
`docs/dws/phase-2-baseline-summary.json` carries the accepted sweep's trimmed summary, with a
`families` field aliasing the tool's native `perFamily` field so this plan's own verify command —
which reads `s.families` — agrees with `dws-offload-measurement.mjs summarize`'s actual output
shape; no raw process list or control-surface command lines are included in the committed file).
