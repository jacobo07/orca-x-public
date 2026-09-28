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

**Credential check** (existence-only, `test -s`, contents never read/printed/copied):
`CLAUDE_CRED=1 CODEX_CRED=1` — a Claude Code credential IS minted in `orca-svc`'s own HOME. The
agent-turn leg is therefore NOT blocked on a missing credential.

**Result**: `exit=1, ms=780, agentReply="missing"`. Remote-proof verdict: UNJUDGED (`not captured`
— 780ms is shorter than the 2s sampling interval).

This is **the exact same failure signature** as the accepted local baseline's own agent leg
(`docs/dws/phase-2-local-ram-offload-evidence.md`, Criterion 1: `agentReply=missing, exit=1`,
reproduced identically across `baseline-1` and `baseline-2`, and shown there to NOT be a
credential or missing-binary issue via three successful direct-spawn reproductions). Observing the
identical signature here — over the paired GEX44 environment, with a confirmed-present credential —
rules out "remote-specific" and "credential-absent" as causes, and instead CONFIRMS the baseline's
own finding: this is a reproducible difference between Orca's terminal/PTY dispatch mechanism and a
direct process spawn, independent of whether the dispatch target is local or remote. Per host_rules
("two identical failures = pivot"), this was not retried a third time through the identical PTY
mechanism.

**Agent-turn leg verdict: neither PASS nor a credential-absence BLOCKED.** Recorded precisely as:

`AGENT_LEG = BLOCKED (reason: reproducible PTY-dispatch failure, agentReply=missing exit=1 — same
signature as the accepted local baseline's agent leg; credential confirmed present
(CLAUDE_CRED=1), ruling out T-02-03's "no credential" cause; root cause not isolated within this
plan's time budget, tracked as follow-up work, never faked or substituted)`

### DWS-P2-SC3 verdict

Per the plan's formula ("PASS only if the desktop attach passed AND the test-run leg has a
remote-proof PASS AND the agent-turn leg is PASS; with the agent leg BLOCKED the verdict is BLOCKED
(agent-turn leg: <reason>; test-run and build legs PASS)"):

**`DWS-P2-SC3 = BLOCKED (agent-turn leg: reproducible PTY-dispatch failure — agentReply=missing,
credential confirmed present, same signature as the local baseline's own agent leg; test-run leg
PASS with remote-proof PASS; build leg exit=0 but remote-proof UNJUDGED due to the 2s capture
interval being longer than the leg's 897ms runtime)`**

Owner action to close the BLOCKED status: none available today — the underlying cause is a product
defect in Orca's PTY/terminal dispatch path (not a credential or configuration gap an Owner action
can fix), tracked as follow-up investigation.

## Criterion 4 — laptop absence, memory delta, stream latency (plan 02-05)

This section records DWS-P2-SC4: during the offload run the laptop carries none of the workload
families the baseline sighted, with the per-family and total MB delta and stream latency measured
against a same-harness local floor.

### Sweeps (both reported)

Two remote sweeps were run; both show the SAME per-family absence result (the laptop sampler saw
zero of every family in both sweeps) and both show an INCONCLUSIVE memory bracket due to this
laptop's own background memory churn exceeding the workload's signal — a genuine host
characteristic, not a defect in the instrument (both sweeps used the identical sampler as the
baseline, per CTX-MEAS-2).

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

Every family the baseline actually sighted (`vitest`, `tsc`, `claude`, `codex`,
`workload-wrapper`) reads **PASS** for absence during the offload run — the workload the baseline
measured locally left no trace on the laptop while running on GEX44. Families the baseline never
sighted stay UNJUDGED, never counted as PASS (CTX-MEAS-3).

### MB delta (per family, baseline minus offload; offload's own footprint is 0 MB for every
family in both sweeps, so the delta equals the baseline's own peak/median)

| Family | Baseline peakMb | Offload peakMb | Peak delta (freed) | Baseline medianMb | Offload medianMb | Median delta (freed) |
|---|---|---|---|---|---|---|
| `vitest` | 610.184 | 0 | **610.184** | 235.656 | 0 | **235.656** |
| `tsc` | 903.657 | 0 | **903.657** | 476.104 | 0 | **476.104** |
| `claude` | 233.859 | 0 | **233.859** | 214.414 | 0 | **214.414** |
| `codex` | 12.391 | 0 | **12.391** | 12.391 | 0 | **12.391** |
| `workload-wrapper` | 56.195 | 0 | **56.195** | 56.156 | 0 | **56.156** |
| `control-surface` (desktop itself, reported separately, never mixed into workloadTotal) | 1362.035 | 0 | 1362.035 | 1013.421 | 0 | 1013.421 |
| **`workloadTotal`** (sum of workload families, per sample, peak) | 956.86 | 0 | **956.86** | 142.305 | 0 | **142.305** |

Instrument: `Win32_Process.WorkingSetSize via Get-CimInstance` (identical sampler to the baseline,
CTX-MEAS-2). Control-surface footprint reported separately in both conditions
(`controlSurfaceFootprint.offload.maxCount=0` — the offload run's own laptop desktop overhead was
not attributed to the workload).

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

**`DWS-P2-SC4 = INCONCLUSIVE (bracket: free-memory drift exceeds the workload's peak delta in both
independent sweeps — offload-1 drift=4092.75MB, offload-2 drift=3032.82MB, both >= delta=956.86MB;
every baseline-sighted family (vitest, tsc, claude, codex, workload-wrapper) reads PASS for
absence; stream latency is MEASURED, N=7, remote medianMs=964.64 vs local-floor medianMs=926.96)`**

The absence claim itself (the workload left no trace on the laptop) is fully proven (PASS on every
positive-controlled family, in both independent sweeps). What remains INCONCLUSIVE is only the
bracket's ability to attribute the ~957MB peak delta specifically to the offload, rather than to
this laptop's own multi-GB background memory churn — a host characteristic outside this plan's
control, not a defect in the measurement instrument (CTX-MEAS-1's bracket rule correctly refused to
claim more than the data supports).
