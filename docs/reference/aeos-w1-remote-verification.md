# AEOS W1 — remote verification on GEX44

Evidence of record for W1 of [autonomous-engineering-os.md](autonomous-engineering-os.md). Like
its siblings it is gitignored and force-added.

Every number below is bound to one revision, one host and one toolchain. A result that cannot
name those three describes nothing in particular.

## Binding

| | |
|---|---|
| Revision | `557eb614eba815ecca720a79b4f9e4916a26a4c7` (branch `orca-x/aeos`, clean) |
| Host | `kobicraft-gex44` — Linux 6.8.0-134, 20 CPU, 64 GB, **shared** |
| Toolchain | Node **v24.21.0** at `~/.orca-toolchain/node24` · system Node **v18.19.1**, untouched · vitest **4.1.5** · pnpm 10.24.0 |
| Runner | `config/scripts/aeos-remote-suite-run.sh --detach`, `--maxWorkers=12` |
| Run directory | `~/aeos-runs/20260922T152538Z-557eb61/` |
| Started / ended | 2026-09-22 15:25:38Z → 15:31:39Z — **6 m 01 s** |
| Host bracket | MemAvailable 60,047 → 59,059 MB · load 0.42 → 10.89 |
| Verdict source | exit code + JSON reporter, read by `config/scripts/aeos-remote-run-verdict.mjs` |

## Verdict

**FAIL — 184 of 55,716 tests failed** (55,254 passed), across 40 files. `rc=1`; the exit code and
the report agree; the host stayed far above the memory floor, so the failures are attributable to
what ran rather than to starvation.

## Two earlier claims this falsifies

Kept, not rewritten. Each was stated with confidence and each was wrong.

1. **"The suite has run ~25 minutes and has not summarised yet."** The log it described had been
   overwritten: the runner of the day wrote to a fixed `~/vitest-clean.log`. The run that *was* in
   that file started 13:06:46Z and last wrote at 13:11:22Z — **4 m 36 s** — then its whole process
   tree disappeared. No `Test Files` line, no exit code, and the runner's own trailing
   `echo VITEST_RC=$?` never ran, which proves the shell died, not that vitest exited. Not OOM (kernel
   log clean), not logind (`KillUserProcesses=no`, `Linger=yes`). Verdict: `PROCESS_TERMINATED`,
   cause unknown. The full suite takes six minutes on this host.
2. **"10 FAIL lines."** A `grep -c FAIL` over that log. Real reporter `FAIL` blocks in it: **zero**.
   The matches were test names and stderr. It was never written into a durable record; it is
   recorded here so it is not rediscovered.

## Classification

The question is whether each failure belongs to GEX44, to Linux, or to the repository. It is
answered **per test file across two platforms**, by running the same files on the Windows
workstation with the same JSON reporter. That is a narrow, named oracle — nineteen files — and it
is not a full-suite workstation baseline, which does not exist and was not invented.

| Class | Tests | Evidence |
|---|---:|---|
| **Host prerequisite** | **4** | `capture-visual-producer`: *could not launch chromium*. Playwright's browser is not provisioned on GEX44 |
| **Linux-divergent, attribution pending** | **8** | fail on GEX44, pass on Windows: `codex-fetcher-pty-settle` 4, `local-file-sink` 2 (`EACCES` from `rmSync` in `/tmp`), `daemon-health` 1, `working-set-restore-evidence` 1 |
| **Repository red, reproduced on both platforms** | **55** | same file, same count or near it, on both hosts — see below |
| **Repository red, by cluster** | **117** | same file family as a reproduced red; not individually rerun |
| **Total** | **184** | |

Reproduced on both platforms (Linux → Windows failing tests): `updater.build-channel-selection`
9 → 9 · `remote-hidden-output-restore-outcomes` 9 → 10 · `git-status-refresh-branch-line-total`
8 → 8 · `updater-linux-package-recovery-actions` 7 → 8 · `artifact-cloud-service` 6 → 12 ·
`electron-builder-mac-channel-config` 4 → 4 · `desktop-startup-ordering` 3 → 3 ·
`cdp-bridge-integration` 2 → 2 · and 1 → 1 each for `electron-builder-config`,
`window-shortcut-policy`, `daemon-tcc-attribution-main-thread`,
`local-pty-provider-foreground-process`, `runtime-metadata`, `orchestration-skill-coverage`,
`worktree-base-directory-watcher`.

The 117 by cluster are the other eleven `updater.*` files (99), plus `artifact-cloud-recovery`,
`artifact-cloud-service-races`, `git-status-refresh`, the `remote-hidden-output` banner repro,
`electron-builder-native-rebuild` and four single-test renderer files.

### What this does and does not say

- **The dominant finding is not about Linux.** The red is the repository's, at this revision, on
  both platforms. GEX44 is reporting it faithfully, not producing it. None of it was introduced by
  this program: the revision's only delta over its base `09d218fab` is files under
  `config/scripts/`, whose one test file passed 13/13.
- **Linux-divergent is not "benign platform difference".** Orca ships on Linux. Each of the eight
  is either a real Linux defect or a test that encodes a non-Linux assumption, and which one is not
  yet read. Calling them platform noise would be the unsupported claim this record exists to avoid.
- **The 117 are inferred.** They share a file family with a reproduced red. That is strong and it
  is not observation.
- **Nothing here is a regression claim.** There is no earlier full-suite result on any host to
  regress from.
- The workstation is the *worse* verification host for at least one file:
  `worktree-base-directory-watcher` fails **21 of 26** there against **1** on GEX44, and that run
  exceeded the ten-minute tool ceiling on a host with 5.8 GB free.

## Defects this wave found in its own instruments

Each was caught by running the thing, not by reading it.

| Defect | Caught by | Fixed in |
|---|---|---|
| A fixed log path destroyed the previous run's evidence | reading the log's `START=` against the claim | `2e7e094be` — a directory per run |
| No exit code, so killed and failed looked identical | the absent trailing `echo` | `2e7e094be` — rc from a trap, written last |
| `git fetch … \| tail` masked a fetch failure under `set -e`; the suite launched on the wrong revision | reading `REVISION=` after launch | launch now asserts the revision before starting |
| The manifest's pgid covered one of the run's two process groups; an abort left 12 workers running | the abort's own survivor listing | `557eb614e` — record and reap the **session** |
| `GROUPS` is a readonly bash array; the reap loop signalled group 1000 | the survivor listing again | named in `aeos-remote-run-abort.sh` |
| Both new CLIs exited 0 on Windows having run nothing (`file://${argv[1]}` never matches) | executing the documented `pnpm` command | `f1c3aa4f0`, reusing the estate's `isEntryPoint` |
| PowerShell → `ssh` stripped quotes from remote arguments, turning `grep -E "a\|b"` into a pipeline | a `command not found` for `vitest` | remote bodies now travel as a UTF-8-no-BOM file on stdin |

Detachment was proven against a real carrier close rather than assumed: the run was launched,
the connection ended, and a fresh connection found it at `ppid=1` with the log growing 148 KB in
25 s.

## `orca serve` liveness

**Proven at host-process altitude**, 2026-09-22 16:19Z, same revision.

| Step | Observed |
|---|---|
| Build | `pnpm build:electron-vite`, detached, `rc=0`; `out/main/index.js` present |
| Launch | the exact argv `serveOrcaApp` builds — `electron <repo> --serve --serve-json --serve-no-pairing` — under `xvfb-run -a`, a **private** display. The CLI shim was bypassed because `build:cli` runs `install-dev-cli.mjs`, a global install on a shared host |
| Ready | 3 s. `{"type":"orca_server_ready","runtimeId":"340e199a-…","boundEndpoint":"ws://0.0.0.0:6769",…,"pairing":{"available":false,"reason":"disabled_by_operator"}}` |
| Listener | `ss -ltnp`: `0.0.0.0:6769` owned by the Electron main, pid 3497480, in this run's session |
| Interaction | a WebSocket upgrade answered **`101 Switching Protocols`**, and again 15 s later |
| Shutdown | SIGTERM to the main → `app.quit()` → port closed in **2 s**; session reaped to zero; other tenants untouched |

What this does not prove: any RPC beyond the handshake, pairing, or a client session. It proves the
runtime server boots headless on this host, binds, answers, stays up, and leaves through its own
quit path.

The first shutdown attempt signalled the `xvfb-run` wrapper, whose pid equalled the session id,
and reported "exited" while the port stayed open. The contradiction printed side by side is what
exposed it. The second attempt resolved the pid from the socket's owner.

### Three findings serve produced

**1. A hidden host prerequisite — the Chromium sandbox.** The sandboxed launch aborts:
*"chrome-sandbox … must be owned by root and have mode 4755."* A dev-installed Electron's helper is
owned by the user. Making it root-setuid is a root mutation on a shared host inside `node_modules`,
which the next install undoes, so it was not done. The owner's own switch
(`ORCA_APPIMAGE_NO_SANDBOX` → `--no-sandbox`) served it. **Posture: on GEX44 serve runs without the
Chromium sandbox.** Serve opens no window, which limits and does not remove what that means.

**2. Public exposure.** Serve binds `0.0.0.0` and exposes no bind-address option;
`--pairing-address` changes only the advertised address. GEX44 has a public IP and **`ufw` is
inactive**. For about two minutes the listener was reachable from the internet and accepted an
unauthenticated WebSocket upgrade, with pairing disabled. A resident serve on this host needs the
port firewalled or bound to loopback first.

**3. Serve instruments the real agent homes on its host.** Two seconds after launch it wrote:

| Path | Change |
|---|---|
| `~/.orca/agent-hooks/` | created, with `codex-hook.sh` and `claude-hook.sh` |
| `~/.codex/hooks.json` | 8 events, each pointing at `codex-hook.sh` |
| `~/.codex/config.toml` | 8 `[hooks.state]` sections pre-trusting those hooks |
| `~/.claude/settings.json` | `hooks` only: 5 pre-existing events became 11. Orca wrote `settings.json.bak` first |

Redirecting `XDG_CONFIG_HOME` did not contain this. The writer is
`src/main/codex/codex-real-home-hook-install.ts`, deliberately targeting the real home, and
`~/.codex` was live: another workload had written to it fourteen minutes earlier.

Both hook scripts exit 0 immediately unless `ORCA_AGENT_HOOK_PORT`, `ORCA_AGENT_HOOK_TOKEN` and
`ORCA_PANE_KEY` are set, and those exist only inside panes Orca launched. For everything else on
the host each hook is **one `sh` fork per event, no network, no decision** — including on
`PermissionRequest`. Inert, but present in configs this program does not own.

**Not reverted.** The configs belong to live workloads, `~/.codex` has no pre-image, and a bad edit
to either file breaks an agent that is running. Preserved instead, mode 600 in a mode-700
directory, `~/aeos-runs/serve-20260922T161903Z-557eb614e/host-side-effects/`:

```
a4701ceb…  claude-settings.json.orca-preimage   (Orca's own backup, taken just before its write)
8b271dff…  claude-settings.json.after
a66354771…  codex-hooks.json.after
3cb1c1c5…  codex-config.toml.after
```

The exact reversal is ready and is the Owner's to authorize: restore Claude from the pre-image if
`settings.json` still hashes `8b271dff…`; in Codex remove the eight `[hooks.state]` sections naming
`hooks.json` and the Orca entries; remove `~/.orca/agent-hooks/`.

**The rule this produces:** a resident Orca on a shared host runs under an **isolated `HOME`**, not
merely an isolated `XDG_CONFIG_HOME`, or it instruments every agent on the machine.

## Still owed for W1

- The cold-birth prerequisite record, which now includes the Playwright browser, the Chromium
  sandbox, the firewall, and the isolated `HOME`.
