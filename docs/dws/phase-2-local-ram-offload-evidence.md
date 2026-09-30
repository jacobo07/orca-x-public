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

**Note (2026-09-30, 02-07):** The remote cause found on 2026-09-29 (an absent provider login in the orca-svc service HOME, Criterion 3) does not apply to this local case: the laptop CLI is logged in and a direct spawn answered 3/3, so this local failure remains unexplained.

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

## Criterion 3 — desktop attach, identity round-trip, remote execution proof (plan 02-05)

This section records DWS-P2-SC3: the real laptop desktop paired to the GEX44 serve as a runtime
client, with a test run and a build run dispatched through that pairing and PROVEN, via timestamped
remote process captures, to have executed on GEX44 rather than the laptop.

### Identity at this plan's deploy

| Field | Value |
|---|---|
| Serve SHA (this plan's dispatch HEAD, redeployed to GEX44) | `b8e385a0ba83e08b9420ccf7f2a3d7282db9f681` |
| Artifact SHA-256 (`deployed.json`, written by `Publish-DwsServeBuild`) | `4c094db99fe0480c6178fbbe835b2fd6d0913c3dd29728360960bc3eee890fc9` |
| Service checkout | `/home/orca-svc/dws-p2/b8e385a` |
| `systemctl show orca-dws-serve.service -p WorkingDirectory --value` | `/home/orca-svc/dws-p2/b8e385a` |
| `sudo git -C <WorkingDirectory> rev-parse HEAD` (queried by the orchestrator before every `-Target remote` run) | `b8e385a0ba83e08b9420ccf7f2a3d7282db9f681` — agrees with `deployed.json.sha` |
| Serve `systemctl is-active` | `active` throughout Task 1 and Task 2 |
| Serve MainPID, before Task 2's sweep | `692875` |
| Serve MainPID, after Task 2's sweep | `692875` (unchanged — `remoteServeMainPidVerdict=STABLE`) |
| Sandbox mode | `no-sandbox` (T-02-05 accepted contingency, unchanged from Criterion 2) |
| Laptop artifact | NOT refreshed by design for the OFFLOAD workload dispatch itself (GEX44-side only); the LOCAL `out/` build backing `orcaPage` in Task 1's Playwright spec WAS rebuilt multiple times during Task 1 (see plan SUMMARY.md's Task 1 deviations: locale fix, test-id additions, terminal-profile fix all touched renderer source) — this affects only the desktop UI harness, never the workload identity or blob hashes, which are verified independently below |

### Attach proof (CTX-CLI-1, CTX-EXP-2)

`attachDwsRemoteRuntime` drives `AddRemoteHostDialog` in server mode with the SSH-tunnel checkbox
checked; the dialog's own `verifyAndAddFromPairingCode` call performs a live `status.get` round-trip
over the tunnel and the dialog cannot close on save without it succeeding — this IS the attach
proof, not an inference from a later action. Saved environment: `connectionDependency: 'ssh-tunnel'`,
confirmed by reading the desktop's own `runtimeEnvironments`/`runtimeStatusByEnvironmentId` store
state immediately after save (`tests/e2e/helpers/dws-remote-runtime-attach.ts`).

**Terminal leg: the REAL UI PATH was used, not the plan's CLI-ladder contingency.** A terminal was
opened via `TerminalPanelToolbar`'s explicit "Choose terminal profile" menu (real desktop control),
on the paired runtime's worktree. Verdict: **PASS**.

### Identity round-trip (Task 1)

| Claim | Instrument | Observed | Verdict |
|---|---|---|---|
| The terminal's own connection identity names the remote host | rendered terminal-rail tab title (ARIA snapshot) | `orca-svc@kobicraft-gex44: ~/dws-p2/b8e385a` | **PASS** |
| A live shell prompt renders before any command is sent | `waitForBufferContains(..., '$', 90_000)` against the pane's `serializeAddon.serialize()` | `orca-svc@kobicraft-gex44:~/dws-p2/b8e385a$ ` | **PASS** |
| `echo DWS-P2-ATTACH-<nonce>; id -un; hostname`'s output appears in the rendered buffer | same xterm buffer, polled at `polling:'raf'` | nonce `attachmulmmgjp`, `orca-svc`, `kobicraft-gex44` all present | **PASS** |

**Note (found via diagnostic buffer dumps, host_rules "two identical failures = pivot"):** the
FIRST identity command sent immediately after `waitForActivePanePtyId` resolves is silently
dropped — a ptyId assignment proves the client-side handle exists, not that the remote shell has
finished spawning over the SSH tunnel. Fixed by waiting for ANY rendered buffer content before
sending input. A SEPARATE, unrelated defect was found and fixed in the same pass: this real,
persistent desktop's remembered *default* terminal-launch profile currently resolves to a Claude
Code agent profile (not a shell) — "New Terminal"'s plus button and the tab-bar's "New Terminal"
menu both launch the ambient default unconditionally, so an automated "open a terminal" action can
silently open an agent CLI instead of a shell on this shared machine. Fixed at the product level by
adding `data-terminal-profile-kind` to each profile-menu entry (`TerminalPanelToolbar.tsx`) so
automation (and any future one) can name a specific profile rather than trust the ambient default.

### Test-run and build-run remote proof (CTX-CLI-4)

`extractRemoteProof(captureText, { servePid: 692875, legs })` against `remote-ps.txt` (1697 lines,
`CAPTURE` blocks every 2s from `2026-09-28T19:33:33Z` to `2026-09-28T19:38:36Z`, spanning every
leg's window):

| Leg | Exit | Duration | Remote-proof verdict | Evidence |
|---|---|---|---|---|
| `test` | `0` | `5535ms` | **PASS** | Capture line: `724358 724305 orca-svc 103056 0 .../node24/bin/node .../vitest/dist/workers/forks.js`; ppid chain `724358 -> 724305 (vitest.mjs run) -> 724298 (dws-offload-workload.mjs test) -> ... -> 692947 (daemon-entry.js) -> 692892 (electron --serve) -> 692875 (MainPID)`; peak RSS `589.14 MB`; first/last seen `19:38:10Z`/`19:38:14Z` |
| `build` | `0` | `897ms` | UNJUDGED (`not captured`) | The leg completed successfully (exit 0) but ran faster than the 2s `ps-capture` sampling interval could reliably catch — absence of a capture is not absence of the process (CTX-MEAS-3 doctrine applied to remote proof); NOT a failure of the leg itself |

Both legs' `exit=0` and `DWS-P2-LEG-END` markers were observed by the Playwright spec via
`terminal list --worktree` + `preview` matching (the `terminal_handle_stale` workaround from
02-01), independent of the ps-capture instrument.

**Workload blob hashes**: `blobHashesMatchBaseline: true` (all 4 files' git blob hashes identical
between the accepted local baseline's checkout SHA and this plan's GEX44 checkout SHA) — the offload
run is a comparable sweep of the SAME workload the baseline measured.

### Agent-turn leg (CTX-CLI-3)

> **Superseded 2026-09-30 (02-07) — kept as recorded, conclusion disproven:**
>
> **Credential check** (existence-only, `test -s`, contents never read/printed/copied):
> `CLAUDE_CRED=1 CODEX_CRED=1` — a Claude Code credential IS minted in `orca-svc`'s own HOME. The
> agent-turn leg is therefore NOT blocked on a missing credential.

**Correction (2026-09-30, 02-07):** That existence check ran as the ssh login user, whose home is kobii's, so it observed kobii's credential and not the service account's. WR-09 (commit 4f6cfa330) now checks `/home/orca-svc/.claude/.credentials.json` through `sudo -n -u orca-svc`, and a run whose service HOME lacks it records the agent leg as BLOCKED instead of running it.


**Result**: `exit=1, ms=780, agentReply="missing"`. Remote-proof verdict: UNJUDGED (`not captured`
— 780ms is shorter than the 2s sampling interval).

> **Superseded 2026-09-30 (02-07) — kept as recorded, conclusion disproven:**
>
> This is **the exact same failure signature** as the accepted local baseline's own agent leg
> (`docs/dws/phase-2-local-ram-offload-evidence.md`, Criterion 1: `agentReply=missing, exit=1`,
> reproduced identically across `baseline-1` and `baseline-2`, and shown there to NOT be a
> credential or missing-binary issue via three successful direct-spawn reproductions). Observing the
> identical signature here — over the paired GEX44 environment, with a confirmed-present credential —
> rules out "remote-specific" and "credential-absent" as causes, and instead CONFIRMS the baseline's
> own finding: this is a reproducible difference between Orca's terminal/PTY dispatch mechanism and a
> direct process spawn, independent of whether the dispatch target is local or remote. Per host_rules
> ("two identical failures = pivot"), this was not retried a third time through the identical PTY
> mechanism.

**Correction (2026-09-30, 02-07):** The same signature does not share a cause. The laptop-local agent-leg failure recorded in Criterion 1 is a separate case: the laptop CLI is logged in and a direct spawn answered 3/3, so that failure stays unexplained. The remote one is an absent provider login in the orca-svc service HOME (next correction). The wrapper printed `missing` because its classifier had no login outcome; 02-07 added `not-logged-in` and `spawn-failed`.


> **Superseded 2026-09-30 (02-07) — kept as recorded, conclusion disproven:**
>
> **Agent-turn leg verdict: neither PASS nor a credential-absence BLOCKED.** Recorded precisely as:
>
> `AGENT_LEG = BLOCKED (reason: reproducible PTY-dispatch failure, agentReply=missing exit=1 — same
> signature as the accepted local baseline's agent leg; credential confirmed present
> (CLAUDE_CRED=1), ruling out T-02-03's "no credential" cause; root cause not isolated within this
> plan's time budget, tracked as follow-up work, never faked or substituted)`

**Correction (2026-09-30, 02-07):** Measured 2026-09-29 by a direct probe as orca-svc in the serve's WorkingDirectory: the agent leg prints `Not logged in · Please run /login`, exit=1, ~0.75 s, both plain and under a real PTY (`script -qec`); the service HOME holds no `.credentials.json` and no auth environment variable. This is recorded in the phase verification (a planning record, not committed). Not claimed: which of the two exit-1 causes (a missing login or an unstartable binary) produced 02-05's own 780 ms run, because its text was not captured; either way the service HOME had no login, so the leg could not have succeeded.

`AGENT_LEG = BLOCKED (reason: no provider login in the orca-svc service HOME; the CLI prints "Not logged in", exit=1; never faked or substituted)`


### DWS-P2-SC3 verdict

Per the plan's formula ("PASS only if the desktop attach passed AND the test-run leg has a
remote-proof PASS AND the agent-turn leg is PASS; with the agent leg BLOCKED the verdict is BLOCKED
(agent-turn leg: <reason>; test-run and build legs PASS)"):

> **Superseded 2026-09-30 (02-07) — kept as recorded, conclusion disproven:**
>
> **`DWS-P2-SC3 = BLOCKED (agent-turn leg: reproducible PTY-dispatch failure — agentReply=missing,
> credential confirmed present, same signature as the local baseline's own agent leg; test-run leg
> PASS with remote-proof PASS; build leg exit=0 but remote-proof UNJUDGED due to the 2s capture
> interval being longer than the leg's 897ms runtime)`**
>
> Owner action to close the BLOCKED status: none available today — the underlying cause is a product
> defect in Orca's PTY/terminal dispatch path (not a credential or configuration gap an Owner action
> can fix), tracked as follow-up investigation.

**Correction (2026-09-30, 02-07):** Corrected verdict:

`DWS-P2-SC3 = BLOCKED (agent-turn leg: no provider login in the orca-svc service HOME; test-run leg PASS with remote-proof PASS; build leg exit=0, remote-proof UNJUDGED at the 2 s capture interval)`

Owner action: open a terminal on the paired `gex44-svc` host in Orca (a child of the serve, so the agent-binary bind exists), run `/home/orca-svc/.orca-dws/agent-bin/claude`, type `/login` and finish the browser flow. Never copy a credential file from another HOME. Plan 02-08 carries the checkpoint.


## Criterion 4 — laptop absence, memory delta, stream latency (plan 02-05)

This section records DWS-P2-SC4: during the offload run the laptop carries none of the workload
families the baseline sighted, with the per-family and total MB delta and stream latency measured
against a same-harness local floor.

### Sweeps (both reported)

> **Superseded 2026-09-30 (02-07) — kept as recorded, conclusion disproven:**
>
> Two remote sweeps were run; both show the SAME per-family absence result (the laptop sampler saw
> zero of every family in both sweeps) and both show an INCONCLUSIVE memory bracket due to this
> laptop's own background memory churn exceeding the workload's signal — a genuine host
> characteristic, not a defect in the instrument (both sweeps used the identical sampler as the
> baseline, per CTX-MEAS-2).

**Correction (2026-09-30, 02-07):** Absence in both offload sweeps was attributed by run nonce only. The remote manifest carried no `desktopRootPid`, so the desktop subtree resolved to size 1: the committed `docs/dws/phase-2-offload-summary.json` records `desktopSubtreeSize=1` and `harnessSubtreeSize=0` (the baseline sighted 251 and 285). No family was looked for inside the desktop's own subtree, where the baseline sighted them. Measured in 02-07: `observationDefects` over that committed summary returns `["no observation record (summary predates the validity checks, or was hand-built)"]`, so the post-review instrument (CR-02) cannot judge it as an observed run. The spec now records `desktopRootPid` (02-07); plan 02-08 re-measures.


| Sweep | Legs | Free MB before/after (orchestrator) | Drift MB | workloadTotal.peakMb (baseline vs offload delta) | Bracket |
|---|---|---|---|---|---|
| `offload-1` | test=0, build=0, agent=1 (`missing`) | 3824.9 / 7977.3 | 4152.4 | 956.86 | drift >= delta -> **INCONCLUSIVE** |
| `offload-2` | test=0, build=0 | 4543.1 / 7526.0 | 2982.9 | 956.86 | drift >= delta -> **INCONCLUSIVE** |

`offload-1` is the accepted sweep for the per-leg remote-proof and agent-leg evidence above (it
includes the agent leg); `docs/dws/phase-2-offload-summary.json` carries its trimmed summary
(cadence `medianMs=1148, samples=239`, `unreadableLines=0`).

### Per-family absence (CTX-MEAS-3), from `docs/dws/phase-2-memory-delta.json`

| Family | Baseline sighted (maxCount) | Offload sighted (maxCount) | Absence verdict | Pattern |
|---|---|---|---|---|
| `vitest` | 1 | 0 | **PASS** | `node`/`node.exe` + `vitest.mjs` |
| `tsc` | 2 | 0 | **PASS** | `node`/`node.exe` + `typescript/bin/tsc`, or `tsc.exe` |
| `claude` | 1 | 0 | **PASS** | `claude.exe`, or `node`/`node.exe` + `@anthropic-ai/claude-code` |
| `codex` | 1 | 0 | **PASS** | `codex.exe`, or `node`/`node.exe` + `@openai/codex` |
| `workload-wrapper` | 1 | 0 | **PASS** | `node`/`node.exe` + `dws-offload-workload.mjs` |
| `esbuild` | 0 | 0 | UNJUDGED (`no positive control`) | `esbuild.exe` |
| `indexer` | 0 | 0 | UNJUDGED (`no positive control`) | `rg.exe`, or `tsserver` |
| `orca-cli` | 0 | 0 | UNJUDGED (`no positive control`) | `node`/`node.exe` + `out/cli/index.js` |

> **Superseded 2026-09-30 (02-07) — kept as recorded, conclusion disproven:**
>
> Every family the baseline actually sighted (`vitest`, `tsc`, `claude`, `codex`,
> `workload-wrapper`) reads **PASS** for absence during the offload run — the workload the baseline
> measured locally left no trace on the laptop while running on GEX44. Families the baseline never
> sighted stay UNJUDGED, never counted as PASS (CTX-MEAS-3).

**Correction (2026-09-30, 02-07):** The per-family PASS above means only that no process carrying the run's nonce was seen outside the desktop subtree. Nothing was sought inside the desktop's own subtree, so it does not show that the workload left no trace on the laptop. It is an attribution result, not an observed absence; the UNJUDGED rows are unchanged.


### MB delta (per family, baseline minus offload; offload's own footprint is 0 MB for every
family in both sweeps, so the delta equals the baseline's own peak/median)

| Family | Baseline peakMb | Offload peakMb | Peak delta (freed) | Baseline medianMb | Offload medianMb | Median delta (freed) |
|---|---|---|---|---|---|---|
| `vitest` | 610.184 | 0 | **610.184** | 235.656 | 0 | **235.656** |
| `tsc` | 903.657 | 0 | **903.657** | 476.104 | 0 | **476.104** |
| `claude` | 233.859 | 0 | **233.859** | 214.414 | 0 | **214.414** |
| `codex` | 12.391 | 0 | **12.391** | 12.391 | 0 | **12.391** |
| `workload-wrapper` | 56.195 | 0 | **56.195** | 56.156 | 0 | **56.156** |
| `control-surface` (desktop itself, reported separately, never mixed into workloadTotal) (offload side unmeasured — see correction) | 1362.035 | 0 | 1362.035 | 1013.421 | 0 | 1013.421 |
| **`workloadTotal`** (sum of workload families, per sample, peak) | 956.86 | 0 | **956.86** | 142.305 | 0 | **142.305** |

> **Superseded 2026-09-30 (02-07) — kept as recorded, conclusion disproven:**
>
> Instrument: `Win32_Process.WorkingSetSize via Get-CimInstance` (identical sampler to the baseline,
> CTX-MEAS-2). Control-surface footprint reported separately in both conditions
> (`controlSurfaceFootprint.offload.maxCount=0` — the offload run's own laptop desktop overhead was
> not attributed to the workload).

**Correction (2026-09-30, 02-07):** The control-surface offload values of 0 are there because the desktop root was unresolved, not because the running desktop used 0 MB, so the 1362.035 / 1013.421 figures are withdrawn as a freed amount. The per-family deltas equal the baseline's own values because the offload side attributed nothing; they are not measured reductions while the bracket is INCONCLUSIVE.


**Bracket verdict: INCONCLUSIVE in both sweeps** (`offload-1`: "free-memory drift 4092.75MB >=
delta 956.86MB"; `offload-2`: "free-memory drift 3032.82MB >= delta 956.86MB"). This laptop's own
free-memory churn (multiple GB of drift within a several-minute window, in both directions, across
two independent sweeps run ~20 minutes apart) exceeds the workload's own ~957MB peak delta, so the
delta cannot be distinguished from ordinary host noise by this bracket rule. This is an honest
INCONCLUSIVE, not a fabricated PASS — CTX-MEAS-1's bracket rule is doing exactly what it is for.

### Stream latency (CTX-MEAS-4, from Task 1)

| | Remote | Local floor |
|---|---|---|
| Verdict | MEASURED | MEASURED |
| N | 7 | 7 |
| Median | 964.64ms | 926.96ms |
| Min/Max | 924.42 / 2978.39ms | 588.80 / 1115.79ms |
| IQR (spread) | 41.71ms | 122.40ms |
| Instrument | `performance.now()` before `Enter` to `waitForFunction(polling:'raf')` seeing the output line in `serializeAddon.serialize()` | same instrument, local terminal via `createOrcaRpc({local:true})` |
| Resolution | 17ms (one rAF frame) | 17ms |

Remote median is ~4% slower than the local floor's median — well within the same order of
magnitude, consistent with both measuring the same harness overhead (xterm buffer poll + Electron
IPC) rather than a network-bound cost from the SSH tunnel.

### DWS-P2-SC4 verdict

Per the plan's formula ("PASS only if every workload family the baseline sighted reads PASS for
absence, the delta is not INCONCLUSIVE, and stream latency is MEASURED"):

> **Superseded 2026-09-30 (02-07) — kept as recorded, conclusion disproven:**
>
> **`DWS-P2-SC4 = INCONCLUSIVE (bracket: free-memory drift exceeds the workload's peak delta in both
> independent sweeps — offload-1 drift=4092.75MB, offload-2 drift=3032.82MB, both >= delta=956.86MB;
> every baseline-sighted family (vitest, tsc, claude, codex, workload-wrapper) reads PASS for
> absence; stream latency is MEASURED, N=7, remote medianMs=964.64 vs local-floor medianMs=926.96)`**
>
> The absence claim itself (the workload left no trace on the laptop) is fully proven (PASS on every
> positive-controlled family, in both independent sweeps). What remains INCONCLUSIVE is only the
> bracket's ability to attribute the ~957MB peak delta specifically to the offload, rather than to
> this laptop's own multi-GB background memory churn — a host characteristic outside this plan's
> control, not a defect in the measurement instrument (CTX-MEAS-1's bracket rule correctly refused to
> claim more than the data supports).

**Correction (2026-09-30, 02-07):** Corrected verdict:

`DWS-P2-SC4 = INCONCLUSIVE (bracket drift 4092.75 / 3032.82 MB >= 956.86 MB in both sweeps; absence PASS by run nonce only — desktop subtree unresolved in both sweeps; stream latency MEASURED N=7)`

Absence is PASS by run nonce only, and the quantitative bracket is INCONCLUSIVE.


## Criterion 5 — quit continuity, reader rung, backfill, reattach latency, device count (plan 02-06)

This section records DWS-P2-SC5: after the laptop desktop quits NORMALLY (a real `app.quit()`, not
a socket drop or kill), the long-running remote workload keeps running on GEX44 under the same
serve MainPID, and a SECOND, independent client (the bundled web client) reattaches and displays
terminal output produced entirely while unattached (BACKFILL), with reattach latency MEASURED at
N>=5.

### Quit + continuity (CTX-CONT-1, CTX-CONT-3)

A bounded (2h, self-terminating) tick loop was dispatched through the paired GEX44 runtime,
confirmed dispatched via a remote `status=active` + `sudo wc -l` >= 5 lines check (no nonce-in-`ps`
check — a compound `for`-loop's own source text is never what `ps` shows for a running shell; see
the spec's deviation note), then the laptop desktop was quit with a real Electron `app.quit()`
while racing the process's own `exit` event against a 30s timeout:

| Field | Value |
|---|---|
| Serve MainPID at dispatch | `692875` |
| Tick line at the moment of quit (`sudo tail -n 1`) | `DWS-TICK-16c66be3b2ea-8 20:51:41` |
| Quit instrument | `electronApp.evaluate(({app}) => app.quit())` raced against `proc.once('exit', ...)`, 30s timeout |
| Exit result | `code=0, signal=null` (359ms) — a clean exit, never a kill |
| Post-quit check (~97s after `quitExitedUtc`) | `status=active`, MainPID still `692875`; tick log at 103 lines (tick 8 at quit → tick 103), i.e. **95 new ticks in ~97 elapsed seconds** (>= elapsed-5=92 required) |

**`CTX-CONT-1/CTX-CONT-3 = PASS`** — the remote workload continued running, unattended, under the
unchanged serve process, entirely independent of the laptop desktop's own lifecycle.

### Reader rung and BACKFILL (research assumption A2, CTX-CONT-2)

The bundled web client (`out/web`, a projected/minified copy of the desktop renderer bundle) has no
xterm accessibility addon wired — the only viable terminal-content reader in this codebase is
`window.__paneManagers.get(tabId).getActivePane().serializeAddon.serialize()`, gated behind the
`VITE_EXPOSE_STORE` build-time flag (a test-instrumentation-only change; no product code touched).
Established live, via a throwaway instrument-first probe before writing the real script.

| Claim | Instrument | Observed | Verdict |
|---|---|---|---|
| The reader is live, not a frozen snapshot | two reads of the pane buffer 2.5s apart | `read1=892, read2=895` | **PASS** |
| BACKFILL: the web client displays output produced entirely while unattached | `read1=892` (live poll immediately after first attach) vs `nQuitTick=8` (tick visible at quit) | `892 > 8` by a wide margin | **PASS** |

**`BACKFILL = PASS`** — resolves research assumption A2 (yes, the web client backfills scrollback
produced while disconnected; it was never re-sent, it was already there).

### Reattach latency (N>=5) and device count

`docs/dws/phase-2-reattach-latency.json` — instrument: `Date.now()` immediately before
`page.reload()`, stopped by `page.waitForFunction(..., {polling:'raf'})` observing a tick number
>= the value read over ssh (`sudo tail -n 1`) immediately before the reload:

| Field | Value |
|---|---|
| N | `6` (>= 5 required) |
| medianMs | `6762.5` |
| minMs / maxMs | `6489` / `8293` |
| iqrMs | `443` |
| resolutionMs | `17` |
| firstAttachLatencyMs (recorded separately, not part of the N=6 set) | `13479` |

**Honest caveat** (recorded in the committed JSON's own `note` field, not hidden): each reattach
probe includes this script's own tab-rediscovery loop, which linear-scans up to 6 terminal tabs
accumulated on this checkout by prior plans' own runs (~700ms settle each) before finding the
tick-loop tab by its nonce content. Part of the measured number is this script's own
O(existing-tab-count) discovery approach, not necessarily an inherent product floor.

**Device count after pairing**: `deviceCountAfterPairing=1`, read from
`window.__store.getState().runtimeEnvironments.length` in the web client's own freshly-paired
context — this measures the web client's own local environment-list length, not a server-side
`DeviceRegistry` paired-device count; recorded honestly as what was actually measured.

### DWS-P2-SC5 verdict

**`DWS-P2-SC5 = PASS`** (continuity PASS with a real clean quit and 95 new remote ticks unattended;
BACKFILL PASS with a live-reader control; reattach latency MEASURED, N=6, medianMs=6762.5;
`docs/dws/phase-2-reattach-latency.json`, `tests/e2e/dws-remote-continuity.spec.ts`,
`config/scripts/dws-web-client-reattach.mjs`)

## Gap closure re-measurement (plans 02-07, 02-08)

### Identity (pre-flight)

Measured 2026-09-29T23:51Z to 23:52Z (laptop UTC clock), 02-08 Task 1.

- Laptop HEAD `f03565ee99588dd25c5b9b6d400033718aaa59af` on `orca-x/distributed-workstation`; `git status --porcelain -- src` empty.
- Desktop artifact sha256: `out/main/index.js` `F62A45CACCEE0140C44C9FCBC9155107C8A259EF9CDEB022FF27812F8D6E2ECA`; `out/cli/index.js` `591FDCBD285D2CCC8B7E4D2490E83C775015A0980A4B40F9FFFBD0C93FA05A3C`. `out/renderer` carries the 02-05 hook (`add-remote-server-save` in `AddRemoteHostDialog-DNcEArg_.js`).
- Laptop free memory 5492 MB at the start of the task.
- Serve (`deployed.json`): SHA `b8e385a0ba83e08b9420ccf7f2a3d7282db9f681`, artifact sha256 `4c094db99fe0480c6178fbbe835b2fd6d0913c3dd29728360960bc3eee890fc9`, service checkout `/home/orca-svc/dws-p2/b8e385a`.
- Unit `orca-dws-serve.service`: `ActiveState=active`, `WorkingDirectory=/home/orca-svc/dws-p2/b8e385a` (equals `deployed.json` svcCheckout), `MainPID=1181474` (elapsed ~9 min at first read, so the serve was restarted after the 02-06 record of MainPID 692875; the checkout and artifact are unchanged, MainPID is a fresh value for this plan). Bound `--serve-bind-host 127.0.0.1 --serve-port 6791 --no-sandbox`.
- GEX44 `df -h /home`: `/dev/md2 1.8T size, 1.6T used, 33G avail, 99%` (the `/home` path sits on `/`).
- `out/web` disclosure: the build clone's `out/web` was hot-swapped by 02-06 with a `VITE_EXPOSE_STORE` bundle; irrelevant to the test/build workload legs.
- Workload-family processes already under `orca-svc` at the read: none (only the serve's own electron tree, Xvfb, its daemon and crashpad handler; no vitest, tsc, claude or codex).
- Tree bracket: `git status --porcelain` path set at task start equals the set at task end (`.claude/`, `.pp-capabilities`, `.pp-pending-spec.json`, `LEARNINGS_PENDING.md`, all untracked and pre-existing); no path moved.

### Comparability (pre-flight)

| path | baseline `8c069f7c6` | deployed `b8e385a` | laptop HEAD |
|---|---|---|---|
| `config/scripts/check-dws-completeness.test.mjs` | `3a0758c0554c` | `3a0758c0554c` (equal) | `3a0758c0554c` |
| `src/main/runtime/runtime-rpc-websocket-bind-host.test.ts` | `7aeb1e74b9cf` | `7aeb1e74b9cf` (equal) | `724ae6019595` (differs: WR-01/WR-02, not deployed) |
| `config/tsconfig.cli.json` | `1f4e6c71269d` | `1f4e6c71269d` (equal) | `1f4e6c71269d` |
| `config/scripts/dws-offload-workload.mjs` | `48d599b4c0e7` | `48d599b4c0e7` (equal) | `e8e24ec604bd` (differs: 02-07 classifier) |

This table is a disclosure only; the machine verdict comes from the run manifest (Task 2).

Transitive-input disclosure: `git diff --stat 8c069f7c6 b8e385a -- src/main src/cli src/shared config/tsconfig.cli.json config/vitest.config.ts` printed nothing (empty).

`BASELINE_MANIFEST=USED` path `%LOCALAPPDATA%\orca-dws-p2\runs\baseline-2\manifest.json`, `checkoutSha` 8c069f7c6033a658be9b69903b448f981530256d, sha256 `8AC435804215DE948145FCB8315875CA444A15DBD42EDC0368E815ACA54DB61B`.

### Classifier real-CLI control

Credential existence check (`sudo -n -u orca-svc test -s`, existence only, contents never read), 2026-09-29T23:52:11Z:

```
CLAUDE_CRED=0
CODEX_CRED=0
```

In words: no Claude and no Codex login exists in the orca-svc service HOME. Agent-binary reachability (2026-09-29T23:52:12Z): `AGENT_BIN_OUTSIDE=0` (the `agent-bin/claude` path is not executable by `orca-svc` outside the serve namespace or not present); node `v18.19.1`.

Control run (login absent, so no paid turn is possible):

- Wrapper blob id `e8e24ec604bdeb2df7feb17af9cbf17072b97451` (`git hash-object --no-filters` of the LF/no-BOM temp copy equals `git rev-parse HEAD:config/scripts/dws-offload-workload.mjs`).
- sha256 local `9226f96715acf5c0c4800f6178a77fdf4fa0e7529e7569de2fdc0639f9a47618`, remote `9226f96715acf5c0c4800f6178a77fdf4fa0e7529e7569de2fdc0639f9a47618` (equal), placed at `/home/orca-svc/.orca-dws/dws-agent-control-e8e24ec.mjs` (0644, orca-svc).
- cwd `/home/orca-svc/dws-p2/b8e385a`, node v18.19.1, form run: `agent --nonce ctl1a2b3c4d` with no `--agent-bin` (AGENT_BIN_OUTSIDE=0).
- CLI's own line: `Not logged in · Please run /login`.
- LEG-END: `DWS-P2-LEG-END nonce=ctl1a2b3c4d leg=agent exit=1 ms=1811 utc=2026-09-29T23:52:49.517Z agentReply=not-logged-in`.

`CLASSIFIER_CONTROL=PASS` (the 02-07 classifier returns `not-logged-in` against the real CLI as orca-svc).

### Sweep identity and comparability (offload-3)

The offload-3 sweep did NOT run. Three launches (RunIds `offload-3`, `offload-3b`, `offload-3c`) each failed before the workload, so no run wrote a manifest, no leg produced a LEG-START, and no summary, delta or remote-proof exists. Nothing below is a measurement of the workload.

Sweep-time identity (same at all three launches): laptop HEAD `f03565ee99588dd25c5b9b6d400033718aaa59af`; `deployed.json` sha `b8e385a0ba83e08b9420ccf7f2a3d7282db9f681`; unit `WorkingDirectory=/home/orca-svc/dws-p2/b8e385a`, `ActiveState=active`, `MainPID=1181474` before and after each launch (no serve restart); `-BaselineManifest` passed (Task 1 recorded `BASELINE_MANIFEST=USED`).

| launch | UTC start | quiescence gate | what stopped it | workload reached |
|---|---|---|---|---|
| `offload-3` | 2026-09-30T00:00:35Z | fired at reading 33, spread 37.3 MB (< 300 MB) | launcher defect: the launcher ran the orchestrator with `$ErrorActionPreference='Stop'` and `& powershell ... *> log`; under Windows PowerShell 5.1 the first stderr line Playwright wrote (`[e2e] SKIP_BUILD set ...`) became a terminating NativeCommandError that killed the orchestrator | no (orchestrator log ends at `playwrightResolvedVia`; no manifest) |
| `offload-3b` | 2026-09-30T00:42:48Z | fired at reading 41, spread 200.9 MB | Playwright global-setup `execSync('git init')` failed: `git` is not on the PATH of the non-interactive PowerShell host (`RUN=offload-3b ... PLAYWRIGHT_EXIT=1 RUN_EXIT=1 REASON=playwright_failed`) | no (no manifest) |
| `offload-3c` | 2026-09-30T00:53:14Z | cap: 54 readings reached (free memory 3959 MB, host busy; the declared rule allows the cap) | transient `ssh.exe : kex_exchange_identification: read: Connection timed out` on the orchestrator's first remote call (the serve status probe), raised as a terminating error before the remote ps-capture started | no (orchestrator log ends at `samplerStarted=true`; no ps-capture, no manifest) |

Deviation from the plan's bound: the plan allows exactly one infrastructure retry (`offload-3b`). `offload-3c` was a second retry, taken because neither earlier launch reached the workload (nothing to re-roll, no verdict existed) and both causes were the launcher's environment. It failed before the workload too, so no fourth launch was made.

Achieved capture cadence: not measured (offload-3's remote-ps.txt was written by a run whose orchestrator was killed and holds no leg; it is not used). Serve MainPID before/after each launch: 1181474 / 1181474.

For these three launches comparability was UNJUDGED (no run manifest exists, so the machine verdict `comparability.verdict` was never produced; UNJUDGED was assigned as the honest absence of that verdict, and the blob table in Task 1 is a disclosure that does not substitute for it). The counted sweep's machine verdict is in `### Sweep identity and comparability (offload-3d)` below. This is the history of the failed launches and is kept as recorded.

### Remote proof (offload-3)

UNJUDGED for both legs: no leg started, so there is no leg window and no childPid to bind a capture to. No `docs/dws/phase-2-offload-3-remote-proof.json` exists.

### Absence (offload-3)

UNJUDGED for vitest, tsc and workload-wrapper: no summary was produced, `desktopSubtreeSize` was never measured, and there is no offload-side positive control. The earlier verdicts (02-05, nonce-only) stand as recorded there and are not upgraded.

### MB delta and control surface (offload-3)

Not measured. No `docs/dws/phase-2-offload-3-memory-delta.json` exists.

### Bracket (offload-3)

Not judged. The quiescence readings of each launch are in the table above (readings every 10 s; declared threshold 300 MB over the last 6 readings, or 54 readings). No counted sweep ran, so no drift and no bracket verdict exist.

### Owner checkpoint and agent leg (02-08 Tasks 3 and 4)

The Owner login checkpoint was resolved by the plan's own rule, unattended: the existence check was re-run at 2026-09-30T00:55:20Z and printed

```
CLAUDE_CRED=0
CODEX_CRED=0
```

so Branch B applied (no redeploy, no agent sweep). No text was treated as an Owner reply. AGENT_LEG = BLOCKED: no provider login in the orca-svc service HOME; the classifier control above is the evidence of what the leg reports (`agentReply=not-logged-in`). Record: `docs/dws/phase-2-agent-leg.json`. Owner action (condensed): keep the tunnel `ssh -N -L 127.0.0.1:6791:127.0.0.1:6791 gex44`, fetch the pairing URL with `ssh gex44 'sudo bash /home/kobii/dws-0104-clone/config/scripts/dws-gex44-serve-provision.sh ready-json'`, pair the gex44-svc host in an Orca desktop with the SSH-tunnel box checked, open a terminal on that host, run `/home/orca-svc/.orca-dws/agent-bin/claude`, type `/login`, finish, `/exit` (Codex: `/home/orca-svc/.orca-dws/agent-bin/codex login`). Never copy a credential file from another HOME.

### Counted sweep note (offload-3d)

`offload-3d` (RunId, 2026-09-30, launcher `runs\offload-3d-launch.ps1`, the offload-3c launcher with only the RunId replaced) is the counted sweep. Why a fourth launch: none of `offload-3`, `offload-3b`, `offload-3c` reached a LEG-START, so no counted sweep existed and no verdict was re-rolled; the orchestrator decided to launch once more and recorded the decision and reason in STATE.md. `offload-3d` reached the workload. Its results are final as measured and nothing was re-run.

### Sweep identity and comparability (offload-3d)

- Sweep-time identity: laptop HEAD `28488c678`; `out/main/index.js` sha256 begins `F62A45CA` and `out/cli/index.js` begins `591FDCBD` (both prefixes equal the pre-flight hashes recorded in `### Identity (pre-flight)`); `deployed.json` sha `b8e385a0ba83...`; unit `WorkingDirectory=/home/orca-svc/dws-p2/b8e385a`, `ActiveState=active`; serve `MainPID` `1181474` before and after (`remoteServeMainPidVerdict=STABLE`); `desktopRootPid` `39176`.
- Tree bracket: the `git status --porcelain` path set at the start equals the set at the end (4 pre-existing untracked paths).
- Orchestrator line: `RUN=offload-3d TARGET=remote PLAYWRIGHT_EXIT=0 FREE_BEFORE_MB=4487.8 FREE_AFTER_MB=4855.9 ... RUN_EXIT=5 REASON=remote_proof_not_pass exit=3`. `PLAYWRIGHT_EXIT=0` means the spec, including its attach step through the paired desktop, completed; `RUN_EXIT=5` is the orchestrator's own refusal because a remote proof is not PASS (the test leg is UNJUDGED, see below). It is a recorded verdict, not an infrastructure failure.
- Remote capture: requested `count=9000 intervalSec=0.2`; achieved 488 `CAPTURE` blocks in `remote-ps.txt` from 2026-09-30T01:03:48Z to 01:05:38Z, a mean interval of 0.226 s. The capture timestamps have 1 s resolution, so a median interval is quantised (median 0 ms, p90 1000 ms) and the mean is the honest cadence figure. Recorded in the summary: 110 laptop samples, median sample interval 1008 ms.
- Manifest `legs` (verbatim): `{"leg":"test","exit":"0","ms":"6129","endUtc":"2026-09-30T01:05:30.322Z","verdict":"OK"}` (no `startUtc`, no `childPid`) and `{"leg":"build","startUtc":"2026-09-30T01:05:35.393Z","childPid":"1399288","exit":"0","ms":"836","endUtc":"2026-09-30T01:05:36.226Z","verdict":"OK"}`.
- Manifest `comparability` (verbatim): `{"verdict":"COMPARABLE","reason":"child inputs identical for legs test,build; wrapper identical","checkedPaths":["config/scripts/check-dws-completeness.test.mjs","src/main/runtime/runtime-rpc-websocket-bind-host.test.ts","config/tsconfig.cli.json"],"mismatched":[],"wrapperMatchesBaseline":true}`.
- Printed from the manifest by `node -e` (never typed): `COMPARABILITY_VERDICT=COMPARABLE`

### Remote proof (offload-3d)

| leg | verdict | capture line |
|---|---|---|
| test | UNJUDGED | `REMOTE-PROOF leg=test verdict=UNJUDGED reason="no LEG-START childPid/startUtc to bind the capture to"` |
| build | PASS | `leg=build verdict=PASS peakRssMb=696.41` (first and last seen 2026-09-30T01:05:35Z, the `tsc` child pid 1399288, recorded in `remote-ps.txt` as `[tsc] <defunct>`; ppid chain 1399288 -> 1399281 -> 1399261 -> 1181618 -> 1181542 -> 1181474 = MainPID) |

Unbound evidence for the test leg (disclosure, not a PASS): `remote-ps.txt` holds a vitest tree at 01:05:24Z to 01:05:30Z, pids 1399002 (`node_modules/vitest/vitest.mjs run --config config/vitest.config.ts config/scripts/check-dws-completeness.test.mjs src/main/runtime/runtime-rpc-websocket-bind-host.test.ts`), 1399058 and 1399059 (workers), peak RSS 606580 KB (592.4 MB), ppid chain 1399002 -> 1398995 -> 1398973 -> 1181618 -> 1181542 -> 1181474 (MainPID). The leg window derived from the manifest (`endUtc` 01:05:30.322Z minus `ms` 6129) starts at 01:05:24.19Z, matching. The verdict stays UNJUDGED because the proof binds a capture to the leg's own `childPid` and `startUtc`, and the manifest has neither for the test leg.

Why the test leg has no LEG-START (02-08 continuation diagnosis, read-only; no code changed):

- MEASURED: `config/scripts/dws-offload-workload.mjs` prints `DWS-P2-LEG-START ... childPid=<pid> utc=...` (line 190) after `spawn` and `DWS-P2-LEG-END` after close; the spec (`tests/e2e/dws-offload-workload.spec.ts`, remote path) learns both only by polling `orca terminal list` and matching regexes on each terminal's `preview` every 3 s plus the RPC round-trip; the manifest's test leg has `endUtc`, `ms` and `exit` (from LEG-END) and no `startUtc`/`childPid`, so the poll saw the END line and never a START line for the test leg, while it saw both for the build leg.
- MEASURED: the test leg is the one that printed vitest's output (6129 ms, 3 vitest processes); the build leg lasted 836 ms and printed little.
- INFERRED (not observed): the terminal `preview` is a bounded tail (the runtime tests pin a 120-line, 32 KiB tail); vitest output plus the 3 s poll let the START line scroll out of the tail before the first poll that saw the finished leg, so only the last line (LEG-END) survived. The same shape can occur if the first poll simply lands after the leg finished. Not verified by reproducing the preview.
- Named follow-up (not done in this plan): make the manifest's leg identity independent of the terminal preview tail, for example by having the wrapper write the LEG-START marker to a file under the run directory on the checkout and having the spec read that file, or by polling with the preview's first-seen state latched before the leg ends. The test-leg proof stays UNJUDGED until then.

### Absence (offload-3d)

`desktopSubtreeSize=40`, `harnessSubtreeSize=64` (both greater than 1; `desktopRootPidValid=true`, `legWindowCovered=true`, `failedLegs=[]`, no `observationDefects`).

| family | baseline maxCount | offload maxCount | verdict | pattern |
|---|---|---|---|---|
| vitest | 1 | 0 | PASS | `node`/`node.exe` with `vitest.mjs` |
| tsc | 2 | 0 | PASS | `node` with `typescript/bin/tsc`, or `tsc.exe` |
| workload-wrapper | 1 | 0 | PASS | `node` with `dws-offload-workload.mjs` |
| claude | 1 | 0 | PASS (baseline-sighted, offload none; vacuous for the agent leg, which did not run) | `claude.exe`, or `node` with `@anthropic-ai/claude-code` |
| codex | not stated in the printed verdict | 1 | FAIL as printed by the tool | `codex.exe`, or `node` with `@openai/codex` |
| esbuild | 0 | 0 | UNJUDGED (no positive control) | `esbuild.exe` |
| indexer | 0 | 0 | UNJUDGED (no positive control) | `rg.exe`, or `node` with `tsserver` |
| orca-cli | 0 | 0 | UNJUDGED (no positive control) | `node` with `out/cli/index.js` |

Codex disclosure: the one sighting is `pid 29228: C:\Users\User\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe app-server` (2.355 MB, 1 of 110 samples), the Codex desktop application running on the laptop, not a process the workload started. The plan's SC4 rung 1 names claude and codex only for the agent sweep (which did not run), so this FAIL does not trip rung 1; it is disclosed here and not hidden, and it is not counted as absence evidence for either side.

### MB delta and control surface (offload-3d)

From `docs/dws/phase-2-offload-3-memory-delta.json` (baseline minus offload, MB): workload total peak delta 954.505, median 142.305. Per family peak/median delta: vitest 610.184 / 235.656; tsc 903.657 / 476.104; workload-wrapper 56.195 / 56.156; claude 233.859 / 214.414; codex 10.036 / 10.036; esbuild, indexer, orca-cli, nonce 0 / 0. Offload-side own workload footprint: peak 2.355 MB (the codex sighting only), median 0.

Control surface (the desktop and harness running on the laptop): baseline peak 1362.035 / median 1013.421 MB (maxCount 19); offload peak 982.336 / median 770.829 MB (maxCount 17, present in 47 samples). Non-zero on the offload side, so the desktop was running; delta 379.699 peak / 242.592 median.

### Bracket (offload-3d)

Quiescence readings (launch log, 10 s apart, free MB): 1 4894; 2 4357.6; 3 4199.6; 4 3886.7; 5 4712.4; 6 4833.5; 7 4081.4; 8 4795.4; 9 4752.6; 10 4638.8; 11 4614.4; 12 4610.8; 13 4646.6. `QUIESCE_FIRED spread<300 (spread=184.599999999999) at reading 13` (2026-09-30T01:03:38Z). Sweep free memory: before 4461.06, after 4662.41, minimum 3046.3.

Bracket verdict: OK, `free-memory drift 201.35 MB < delta 954.505 MB`. It is recorded once; the movers list owed only for an INCONCLUSIVE bracket is therefore not produced.

### Re-measured verdicts (02-08)

**`DWS-P2-SC3 = BLOCKED`** (agent-turn leg: no provider login in the orca-svc service HOME; test-run leg remote proof UNJUDGED, the offload-3d manifest has no LEG-START childPid/startUtc for the test leg; build leg remote proof PASS, peakRssMb=696.41, does not gate SC3; attach: the offload-3d Playwright run through the paired desktop exited 0)

**`DWS-P2-SC4 = BLOCKED`** (rung 4: claude/codex absence vacuous, agent-turn leg BLOCKED on no provider login in the orca-svc service HOME; rungs 1-3 measured on offload-3d: no absence FAIL on vitest, tsc, workload-wrapper; comparability COMPARABLE; bracket OK, free-memory drift 201.35 MB < workload peak delta 954.505 MB; esbuild, indexer and orca-cli are UNJUDGED by name, never counted; stream latency stays MEASURED, 02-05)

Superseded by this 02-08 continuation (offload-3d); the earlier lines are kept readable below. Superseded SC3, from 02-08 Task 4: SC3 was BLOCKED (agent-turn leg: no provider login in the orca-svc service HOME; test-run leg remote proof not re-measured in 02-08 because offload-3 never ran, the 02-05 PASS stands as recorded; build leg remote proof UNJUDGED, not re-captured at 0.2 s for the same reason). Superseded SC4, from 02-08 Task 4: SC4 was INCONCLUSIVE (comparability UNJUDGED: no offload-3 run manifest exists, the sweep never reached the workload in three launches; absence, MB delta and bracket not re-measured; the desktop subtree stays unresolved and absence stays nonce-only as corrected by 02-07; claude/codex absence remains vacuous because the agent-turn leg is BLOCKED; families never sighted by the baseline (esbuild, indexer, orca-cli) are UNJUDGED; stream latency stays MEASURED, 02-05)

## Phase 2 verdict table

| Criterion | Verdict | Instrument | Evidence file | SHA |
|---|---|---|---|---|
| SC1 (local baseline) | **PASS** (baseline sweep `baseline-2`; agent leg UNMEASURED, reason recorded in Criterion 1) | `dws-offload-workload.mjs` + laptop process sampler, ~1s cadence | `docs/dws/phase-2-baseline-summary.json` | `883138dcf` |
| SC2 (loopback-only serve, no public port) | **PASS** (all four legs (a)-(d)) | `Test-DwsNoPublicPort -Port 6791`, `ss`/`curl`/`TcpClient` from inside and outside the host | `docs/dws/phase-2-local-ram-offload-evidence.md` Criterion 2 | `b8e385a0b` |
| SC3 (desktop attach + remote execution proof) | **BLOCKED** (agent-turn leg: no provider login in the orca-svc service HOME; test-run leg PASS with remote-proof PASS; build leg exit=0, remote-proof UNJUDGED at the 2 s capture interval) (corrected 2026-09-30, 02-07) (re-measured 2026-09-30, 02-08: **BLOCKED** — agent-turn leg still has no provider login in the orca-svc service HOME; test-run leg remote proof UNJUDGED (no LEG-START childPid/startUtc for the test leg in the counted sweep offload-3d); build leg remote proof PASS, peakRssMb=696.41, does not gate SC3; an earlier 02-08 pass had recorded neither because no launch reached the workload) | `extractRemoteProof` against timestamped `ps --forest` captures under the serve MainPID | `docs/dws/phase-2-offload-summary.json`, `docs/dws/phase-2-offload-3-remote-proof.json`, `docs/dws/phase-2-offload-3-summary.json`, `tests/e2e/dws-offload-workload.spec.ts` | `0b805a9b2` |
| SC4 (laptop absence + memory delta + stream latency) | **INCONCLUSIVE** (bracket drift 4092.75 / 3032.82 MB >= 956.86 MB in both sweeps; absence PASS by run nonce only — desktop subtree unresolved in both sweeps; stream latency MEASURED N=7) (corrected 2026-09-30, 02-07) (re-measured 2026-09-30, 02-08: **BLOCKED** — counted sweep offload-3d: comparability COMPARABLE, absence PASS for vitest, tsc and workload-wrapper with desktopSubtreeSize 40, bracket OK (drift 201.35 MB < peak delta 954.505 MB); stopped at rung 4 because no agent sweep ran, so claude/codex absence is vacuous; an earlier 02-08 pass had recorded INCONCLUSIVE because no launch reached the workload) | laptop process sampler + `dws-offload-measurement.mjs compare`/`latency` | `docs/dws/phase-2-memory-delta.json`, `docs/dws/phase-2-offload-3-memory-delta.json`, `docs/dws/phase-2-stream-latency-remote.json` | `77314485a` / `d1a0ca38f` |
| SC5 (quit continuity + web-client reattach + backfill) | **PASS** (real clean quit, 95 new remote ticks unattended under the unchanged serve MainPID; BACKFILL PASS with a live-reader control; reattach latency MEASURED N=6) | `electronApp.evaluate(app.quit())` raced against the process `exit` event; `window.__paneManagers...serializeAddon.serialize()` via a headless msedge second client | `tests/e2e/dws-remote-continuity.spec.ts`, `config/scripts/dws-web-client-reattach.mjs`, `docs/dws/phase-2-reattach-latency.json` | `84ca86e8c` |

> **Superseded row text (2026-09-30, 02-07):**
>
> | SC3 (desktop attach + remote execution proof) | **BLOCKED** (agent-turn leg: reproducible PTY-dispatch failure, `agentReply=missing exit=1`, same signature as the accepted local baseline's own agent leg, credential confirmed present; test-run and build legs PASS) | `extractRemoteProof` against timestamped `ps --forest` captures under the serve MainPID | `docs/dws/phase-2-offload-summary.json`, `tests/e2e/dws-offload-workload.spec.ts` | `0b805a9b2` |
> | SC4 (laptop absence + memory delta + stream latency) | **INCONCLUSIVE** (absence PASS on every baseline-sighted family with positive controls, both sweeps; the quantitative MB bracket is INCONCLUSIVE — free-memory drift exceeds the workload's peak delta in both sweeps; stream latency MEASURED N=7) | laptop process sampler + `dws-offload-measurement.mjs compare`/`latency` | `docs/dws/phase-2-memory-delta.json`, `docs/dws/phase-2-stream-latency-remote.json` | `77314485a` / `d1a0ca38f` |

> **Superseded 2026-09-30 (02-07) — kept as recorded, conclusion disproven:**
>
> Only SC1, SC2 and SC5 are unqualified PASS. SC3 is BLOCKED on a product defect (not a credential or
> configuration gap). SC4's decisive half (absence) is proven; its quantitative bracket is
> INCONCLUSIVE on this specific laptop's own background memory churn. Neither BLOCKED nor
> INCONCLUSIVE is upgraded to PASS by this plan — both are carried forward honestly, per host_rules
> ("never upgrade SC3/SC4 without new evidence").

**Correction (2026-09-30, 02-07):** Only SC1, SC2 and SC5 are unqualified PASS. SC3 is BLOCKED on an Owner login in the orca-svc service HOME. SC4 is INCONCLUSIVE, with absence judged by run nonce only. Neither is upgraded to PASS without new evidence.


## Named debt

| ID | Decision | Debt | Retire when |
|---|---|---|---|
| ND-1 | D1 | Autonomous evidence lanes reach GEX44 by bundle+ssh until UWCP S5's dispatcher path exists | The replacement dispatcher path has run once |
| ND-2 | D2 | The laptop reaches GEX44's loopback-only `orca serve` through an Owner-key `ssh -L` forward, not the dispatcher-owned tunnel D2 names | UWCP S5's dispatcher-owned tunnel has carried one paired-client session to `orca serve` on GEX44 |

## Open legs

| Item | State | Reason | Owner action to close |
|---|---|---|---|
| SC3 agent-turn leg | BLOCKED | No provider login in the orca-svc service HOME: the CLI prints `Not logged in · Please run /login`, exit=1 (measured 2026-09-29) (corrected 2026-09-30, 02-07) | Open a terminal on the paired `gex44-svc` host in Orca, run `/home/orca-svc/.orca-dws/agent-bin/claude`, type `/login` and finish the browser flow; never copy a credential file from another HOME (02-08 carries the checkpoint) |
| SC3 agent-turn leg, 02-08 re-check | BLOCKED | Re-measured 2026-09-30T00:55:20Z: still no provider login in the orca-svc service HOME (Claude and Codex both absent; existence check only). The classifier control against the real CLI returns `not-logged-in` (`docs/dws/phase-2-agent-leg.json`) | Same login; then re-run the agent leg (02-08 Task 4 branch A) |
| SC3 build leg remote-proof | CLOSED (PASS) | Re-measured 2026-09-30 in the counted sweep offload-3d at the 0.2 s capture (achieved mean 0.226 s): `leg=build verdict=PASS peakRssMb=696.41`, tsc pid 1399288 bound by LEG-START, chain to MainPID 1181474. Evidence: `docs/dws/phase-2-offload-3-remote-proof.json` (superseded state: UNJUDGED at the 2 s capture, then three launches that failed before the workload) | None |
| SC3 test-leg remote-proof (LEG-START follow-up) | UNJUDGED | offload-3d manifest has the test leg's `endUtc`/`ms`/`exit` but no `startUtc`/`childPid`, so the proof cannot bind the capture (`REMOTE-PROOF leg=test verdict=UNJUDGED`). An unbound vitest tree under MainPID was captured at 01:05:24Z-01:05:30Z (592.4 MB peak); it is not counted. Probable cause (inferred): the terminal preview tail dropped the LEG-START line, see `### Remote proof (offload-3d)` | Follow-up code change, not made here: make leg identity independent of the terminal preview tail (wrapper writes LEG-START to a run-directory file the spec reads, or latch first-seen state). Then one more offload sweep; the 02-05 test-leg PASS stands as recorded history |
| SC4 quantitative MB bracket | CLOSED (OK) | Counted sweep offload-3d: free-memory drift 201.35 MB < workload peak delta 954.505 MB (quiescence fired at reading 13, spread 184.6 MB). Evidence: `docs/dws/phase-2-offload-3-memory-delta.json` | None |
| Row 46 agent-turn leg (GEX44 heavy execution) | BLOCKED | Same cause as the SC3 agent-turn leg: no provider login in the orca-svc service HOME (corrected 2026-09-30, 02-07) | Same login as the SC3 agent-turn leg — one cause, two matrix rows |
| SC4 absence attribution | CLOSED for vitest, tsc, workload-wrapper (PASS) | The 02-07 desktopRootPid fix reached the run: desktopSubtreeSize 40, harnessSubtreeSize 64, `desktopRootPidValid=true`. claude/codex absence stays vacuous (agent leg BLOCKED); esbuild, indexer, orca-cli UNJUDGED (never sighted by the baseline); a Codex desktop app process (pid 29228) was sighted once and is disclosed | The agent-turn login, then one agent sweep, closes the claude/codex half and SC4 |
| ND-2 (ssh -L tunnel) | Named debt | The laptop reaches GEX44 through an Owner-key `ssh -L` forward, not a dispatcher-owned tunnel | Retires when UWCP S5's dispatcher-owned tunnel carries one paired-client session to `orca serve` on GEX44 |
| Row 49 (Security), 52 (Knowledge Vault), 53 (UKDL), 54 (Constitutive Baseline Ratchet) | ABSENT | `reason: program` — out of this plan's scope, owned by later phases/programs | None — tracked at the program level, not this plan |

> **Superseded row text (2026-09-30, 02-07):**
>
> | SC3 agent-turn leg | BLOCKED | Reproducible PTY-dispatch failure (`agentReply=missing exit=1`), same signature as the accepted local baseline's own agent leg; credential confirmed present in the service HOME, ruling out a missing-credential cause | None available today — this is a product defect in Orca's terminal/PTY dispatch path, tracked as follow-up investigation; root cause not isolated within this plan's time budget |
> | Row 46 agent-turn leg (GEX44 heavy execution) | BLOCKED | Same PTY-dispatch defect as the SC3 agent-turn leg, reproduced again on GEX44 | Same as SC3 agent-turn leg — one underlying product defect, two matrix rows |

## State left in place

**GEX44:**

- `orca-svc` service account, unchanged.
- `orca-dws-serve.service` — `active`, bound to `127.0.0.1:6791`, MainPID `692875` (unchanged
  across the entire duration of this plan's execution, including the desktop quit and both Task 2
  measurement passes).
- 02-08 update: MainPID is `1181474` (the serve was restarted between 02-06 and 02-08; same checkout `/home/orca-svc/dws-p2/b8e385a`, same artifact sha256 `4c094db99fe0480c6178fbbe835b2fd6d0913c3dd29728360960bc3eee890fc9`); it did not change across the three 02-08 launches. No redeploy was made by 02-08 (Branch B).
- Service checkout: `/home/orca-svc/dws-p2/b8e385a` (unchanged by 02-08).
- 02-08 placed the classifier control copy `/home/kobii/dws-agent-control-e8e24ec.mjs` and `/home/orca-svc/.orca-dws/dws-agent-control-e8e24ec.mjs` (sha256 `9226f96715acf5c0c4800f6178a77fdf4fa0e7529e7569de2fdc0639f9a47618`); left in place, disposable.
- Build clone HEAD (`/home/kobii/dws-0104-clone`, used for dispatching `status`/provisioning
  commands): unchanged by this plan — never moved, per host_rules.
- Tarballs, bundles and refs under `/home/kobii/orca-x`: unchanged by this plan.
- Tick-loop shells and idle terminal shells created by this plan's own dispatches were stopped and
  verified via a fresh `status`/`ps -u orca-svc` capture returning to the same 5 pre-existing
  (unrelated, prior-plan) `bash --rcfile` shells present before this plan started.

**Laptop:**

- Worktree: `C:\Users\User\Apps\orca-dws-wt` (this checkout).
- `$env:LOCALAPPDATA\orca-dws-p2\` — unchanged.
- `ssh -L` tunnel (PID `43824`, forwarding `127.0.0.1:6791`): stopped via `Stop-DwsTunnel`;
  confirmed no ssh process holding the `6791` forward remains.
- 02-08: each launch's tunnel was stopped by its launcher (last: pid 42720, offload-3c) and no listener on `6791` remains; every 02-08 throwaway pairing file was deleted (`pairing-offload-3*.json` do not exist). Run state dirs `runs\offload-3`, `offload-3b`, `offload-3c` (with `offload-3\samples.ndjson`, about 470 MB) remain under `%LOCALAPPDATA%\orca-dws-p2\` and are not committed.
- 02-08 continuation (counted sweep `offload-3d`): serve MainPID `1181474` before and after, no redeploy, service checkout `/home/orca-svc/dws-p2/b8e385a` unchanged. Verified after the run: no listener on `127.0.0.1:6791`, no `ssh -L` forward process (the only ssh processes are unrelated `browser-automation/mcp.sh` sessions), and no `pairing-offload-3*` file exists (two older pairing files from earlier plans, `pairing-for-e2e.json` and `pairing-throwaway-06.json`, were not created by this run and were not touched). Run dir `runs\offload-3d` (with `samples.ndjson` of about 25 MB, `remote-ps.txt`, `manifest.json`, `summary.json`, `remote-proof.json`) and the `offload-3d-*` launcher and orchestrator logs remain under `%LOCALAPPDATA%\orca-dws-p2\` and are not committed.
- No orphaned Electron, Playwright, or msedge processes remain from this plan's execution.
