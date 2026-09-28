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
