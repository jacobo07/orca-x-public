# Phase 15: remote-first continuity, evidence

Row 75 of the DWS completion matrix asks for a two-host harness that exercises Windows and GEX44 over real SSH. The authority is the STATE.md two-host authorization: this laptop's Orca may talk to a GEX44 disposable root only (`/tmp/orca-hwf-p15-*`, throwaway HOME, loopback private sshd), never to kobii's real home and never to the VPS.

Plane names used below: LOCAL-HOST (only the laptop observes), REAL-SSH (a real ssh handshake or ssh command to GEX44), REAL-TWO-HOST (a real Orca on the laptop driving a real relay on GEX44). The phase-2 runtime-environment leg (02-06, commit 84ca86e8c) is cited, not re-run (D-05).

## Run 1 (15-01): harness tracer

Fence and identifiers:

| item | value |
|---|---|
| laptop HEAD S (spec first real run) | 91767c52fc21ec6c9d11d05c1af0053bf96abda6 |
| laptop HEAD S2 (move-only carrier split, rerun, the kept log) | 426117e857ee1824cfb4874d3257da5df04c7e44 |
| disposable root | /tmp/orca-hwf-p15-20260930T232527Z |
| remote private sshd | 127.0.0.1:38395 (loopback only) |
| laptop local forward | 127.0.0.1:61013 (ssh -L over the `gex44` alias) |
| host key fingerprint (ssh-keygen -lf) | SHA256:Kacc8d/Rzj0EZ3rsN9ClMJ26izq4bSUiF35fdF8QhqI |
| remote hostname | kobicraft-gex44 |
| local relay version (`out/relay/linux-x64/.version`) | 0.1.0+c1eb18e241d9 |
| remote `home/.orca-remote` listing | relay-0.1.0+c1eb18e241d9 |
| CURL on the throwaway login PATH | /usr/bin/curl |
| PROVIDER_CODEX | /usr/local/bin/codex |
| PROVIDER_CLAUDE | /usr/local/bin/claude |

| leg | plane | instrument | observed value | verdict | commit |
|---|---|---|---|---|---|
| harness committed | LOCAL-HOST | `git ls-files` + T1 verify (no `rm`, no parameter expansion, root guard) | provisioner and driver tracked; wrong root refused (`REFUSED root=/tmp/not-ours`, exit 2) | PASS | 9d0395e52 |
| provisioner create | REAL-SSH | `create` over the base64 one-argument lane, nested `ssh -n` probe | sshd alive, `HOME_SEEN=<root>/home`, seeded repo with one commit | PASS | 9d0395e52 |
| zero repos at start | REAL-TWO-HOST | `window.__store.repos.length` in a fresh-profile Orca | `HWF_ZERO_REPOS=yes` | PASS | 426117e85 |
| trust pin equals ssh-keygen | REAL-TWO-HOST | phase-14 first-contact dialog, then `listTargets().hostKeyPin` | `HWF_PIN` equals the ssh-keygen fingerprint above | PASS | 426117e85 |
| relay fence | REAL-SSH | local `.version` against `ls home/.orca-remote` through the carrier host | `HWF_RELAY_FENCE=match local=0.1.0+c1eb18e241d9 remote=relay-0.1.0+c1eb18e241d9` | PASS | 426117e85 |
| terminal on the owning host | REAL-TWO-HOST | `printf` of `$(hostname)` and `$(pwd)` with a split marker, parsed from the pane | `host=kobicraft-gex44 pwd=<root>/repos/p15-repo` | PASS | 426117e85 |
| laptop absence of the host-only content | LOCAL-HOST scan of a REAL-TWO-HOST run | content-nonce search over the Electron userData dir and recent top-level temp entries, control planted in each root | `verdict=PASS control=found hits=0 files=31909 unreadable=6 capped=false` | PASS (scope below) | 426117e85 |
| containment | REAL-SSH | witnesses before and after, `procs` after teardown | see below | PASS | this commit |

Both real runs ended `1 passed` with nothing skipped: the first at S (3.2 min), the second at S2 (8.2 min). The environment-less run shows `1 skipped` only, so a missing opt-in reads as NOT RUN.

Absence scope, stated plainly. Only file CONTENT is searched, and only for the nonce written into the GEX44 seed file. Paths, terminal markers and commit messages are references the client legitimately holds (session state may persist them), so they are excluded by design. The userData dir (which holds the isolated HOME) is scanned whole. The laptop temp dir holds about 229,000 unrelated files (roughly 20 GB), so it is scanned only for top-level entries modified since 60 s before the test started; a write into an older, pre-existing top-level temp directory is not seen. Six files could not be opened (locked) and are counted, not treated as clean.

Containment. Witnesses before and after, taken with the `witness` verb:

| witness | before | after |
|---|---|---|
| kobii `known_hosts` SHA-256 | eee39ff279a28b40862a2a1e01e663a84d09d9c1527f9438fa8cda0ff014694f | eee39ff279a28b40862a2a1e01e663a84d09d9c1527f9438fa8cda0ff014694f |
| `/home/kobii/orca-x` HEAD | f9a721fda491096b74f0115d78632356e526d096 | f9a721fda491096b74f0115d78632356e526d096 |
| real-home `.orca-remote` listing hash | absent | absent |

Root-scoped processes before teardown: 5 (the private sshd, two detached relays from the two runs with `--grace-time 0`, two PTY shells). After teardown: `REMAINING=0` and `PROC_COUNT=0`. The root directory is left in place; a `status` call after teardown prints `SSHD_ALIVE=no`. No pairing URL, credential or private key is in this file; the generated client key lives only in the laptop temp dir and is a disposable key.

Observations carried forward:

- With `relayGracePeriodSeconds` omitted the product default applies (0, unlimited while PTYs live), so each run leaves a detached relay and PTY shell until the provisioner's `teardown` stops them.
- The app log printed `recovery failed Error: terminal_liveness_unavailable` twice per run without failing the leg; not investigated here.
- Both provider binaries (`codex`, `claude`) are present on the throwaway login PATH, which matters for the agent leg in 15-02.

## Run 2 (15-02): row 59 legs on the owning host

Plane: REAL-TWO-HOST for every client leg (a fresh-profile Orca on this laptop, Client A direct over ssh2, Client B the paired web client through the HUB), with an independent `ssh gex44` read inside the root as the instrument for fs and git. Claim level for the agent half: **agent process + hook routing on the owning host, no model turn** (D-13). OD-1 default taken: no prompt was ever sent to a provider and no credential was copied or created.

Fence: disposable root /tmp/orca-hwf-p15-20261001T000006Z, private sshd 127.0.0.1:43001, host key SHA256:nStxsKJCsJviLsuVY20enFMTgAYpAp8FepE3QeRjVAA, local forward 127.0.0.1:61013, relay relay-0.1.0+c1eb18e241d9.

Probe values (measured before any leg used them, 15-02-probe.txt): `HWF_PROBE_WEB_GIT_COMMIT=function`, `HWF_PROBE_WEB_AGENT_STATUS=present`, `HWF_PROBE_SSH_AGENT_MENU=claude` (the Codex item is not offered on the SSH worktree; Claude is), `CURL=/usr/bin/curl`, `PROVIDER_CODEX=/usr/local/bin/codex`, `PROVIDER_CLAUDE=/usr/local/bin/claude`. Consequence: Client B's git leg and hook leg were required, and part a launched `claude`.

| leg | client | plane | instrument | observed value | verdict | commit |
|---|---|---|---|---|---|---|
| terminal | A | REAL-TWO-HOST | split-marker printf of hostname and pwd | `host=kobicraft-gex44 pwd=<root>/repos/p15-repo` | PASS | d44e30dbb |
| terminal | B (web) | REAL-TWO-HOST | same, typed through the web client | same values; one bounded retype needed (keystrokes before the remote shell was ready are dropped) | PASS | d44e30dbb |
| fs create/write/rename/copy/delete | A | REAL-TWO-HOST | ssh read of contents then absence; full SshMutationExpectation | `HWF_FS_A=ok` | PASS | d44e30dbb |
| fs create/write/rename/copy/delete | B (web) | REAL-TWO-HOST | ssh read of contents then absence | `HWF_FS_B=ok` | PASS | d44e30dbb |
| git stage+commit | A | REAL-TWO-HOST | ssh `rev-parse HEAD` and `log -1 --format=%s` against the client's history read | client sha equals remote sha (c58e7f61eafb862f978590a24b49196879069d14) | PASS | d44e30dbb |
| git stage+commit | B (web) | REAL-TWO-HOST | same | client sha equals remote sha (c8c6eb63a7ee92f2136bd33fd67c701dfd8eed2e); ssh HEAD after the run equals it | PASS | d44e30dbb |
| laptop absence | both | LOCAL-HOST scan of a REAL-TWO-HOST run | content nonces: seed plus every fs and git content nonce, controls planted | `verdict=PASS control=found hits=0 files=30755 unreadable=6` | PASS (scope as in Run 1) | d44e30dbb |
| agent part a (real provider launch) | A | REAL-TWO-HOST | `procs` verb: argv contains `claude`, cwd = host-only repo, alive 10 s later | `observed provider=claude pid=1894171 cwd=<root>/repos/p15-repo`, no prompt, no login | PASS | 4984de149 |
| agent part b (hook routing) | A | REAL-TWO-HOST | codex hook posted from the remote PTY to the relay hook endpoint, desktop store poll | `HWF_HOOK_A=ok` (row keyed to the HUB pane key) | PASS | 4984de149 |
| agent part b (hook routing) | B (web) | REAL-TWO-HOST | web store poll by the unique prompt nonce | `HWF_HOOK_B=ok` | PASS, see note | 4984de149 |
| supplementary stub launch | A | REAL-TWO-HOST | `procs` verb on the root-resident stub | `observed pid=1894361 cwd=<root>/repos/p15-repo (supplementary; not a provider)` | supplementary only | 4984de149 |

Observations, not fixes:

- The web client re-keys a delivered hook row to its own `web-terminal-*` pane, so the row exists in the web store under a different key than the HUB pane key. The web leg therefore matches on the unique prompt nonce; key equality is asserted on the desktop only.
- `git.stage` takes a worktree-relative path on the desktop IPC and an absolute path on the paired web shim (a relative one is refused as outside the runtime worktree). Left as is.
- Part a launched `claude`, not `codex`, because the New-tab menu on the SSH worktree offers only Claude. Part a is therefore observed for one provider. A model turn was not run (OD-1), so row 59 stays bounded by D-13/D-15: process and hook routing are proven, a provider turn is not.
- The app log printed `recovery failed Error: terminal_liveness_unavailable` twice per run again; not investigated (it belongs to 15-03).
- The paired web client's worktree list (`[data-worktree-sidebar]`) is not mounted on its landing surface, so readiness is taken from the web store seeing the host worktree and activation goes through the store.

Containment. Witnesses equal before and after: known_hosts eee39ff279a28b40862a2a1e01e663a84d09d9c1527f9438fa8cda0ff014694f, `/home/kobii/orca-x` HEAD f9a721fda491096b74f0115d78632356e526d096, real-home `.orca-remote` listing absent. Root-scoped processes before teardown: 29 (sshd, stacked detached relays from this plan's runs, their PTY shells and the launched agent processes); after teardown `REMAINING=0` and `PROC_COUNT=0`, `SSHD_ALIVE=no`. The throwaway home holds only what Orca and the CLIs created (`.claude`, `.codex`, `.orca*`, `.npm`), no credential file was placed there by the harness. No pairing link, token or private key is in this file.

## Run 3 (15-03): reconnect

Plane: REAL-TWO-HOST for every leg (a fresh-profile Orca on this laptop, Client A direct over ssh2, Client B the paired web client through the HUB). The only injected event is the laptop's `ssh -L` carrier (killed, then restored on the SAME local port, because the host-key pin is keyed by host and port). Orca's own reconnect ladder did the reconnect: the test makes no `ssh.connect` call after the initial trust connect, and the connection generation advanced by itself. The relay and the PTYs on the host were never touched. Independent instrument: `ssh gex44` reads inside the root (`procs`, the tick file, the hook log), which does not share the carrier under test.

Fence: disposable root /tmp/orca-hwf-p15-20261001T011505Z, private sshd on loopback, local forward 127.0.0.1:61013, host key SHA256:vPaVkQvrhR4iNIh6Z8Q6i7wHYcdAsV/FwyCGYgEFERQ, relay relay-0.1.0+c1eb18e241d9, code at 6fb064b7b. Product default grace (the target is created without `relayGracePeriodSeconds`).

| leg | client | plane | instrument | observed value | verdict | commit |
|---|---|---|---|---|---|---|
| product reports the drop | A | REAL-TWO-HOST | store `sshConnectionStates` polled after the carrier kill | `reconnecting` 26-27 ms after the kill (both runs) | PASS | 6fb064b7b |
| ladder reconnect, no test-side connect | A | REAL-TWO-HOST | generation read before the kill and after `connected` | generation +2 (shell run 2683136067756033 to 2683136067756035, agent run 5769759135891457 to 5769759135891459); `connected` 10.3 s and 8.3 s after the carrier was restored; outage held 23.1 s and 22.9 s; app log `Reconnected to existing relay via socket` | PASS | 6fb064b7b |
| same relay | host | REAL-TWO-HOST | `procs`: the `.orca-remote` ancestor of the pane shell | pid 1922771 before and after | PASS | 6fb064b7b |
| same shell | A | REAL-TWO-HOST | `echo $$` in the pane AND `procs` (cwd = host-only repo) | pid 1923552 before and after, alive, same pty id, shells under the relay 1 to 1 | PASS | 6fb064b7b |
| gap-free work | A | REAL-TWO-HOST | foreground tick loop writing a file in the root | 39 ticks, numbers 1..39 consecutive, largest epoch gap 1.011 s | PASS | 6fb064b7b |
| backfill of the outage | A | REAL-TWO-HOST | ticks whose remote epoch lies inside the outage window (measured skew 0.44 s, margin 5 s) found in A's terminal buffer | 13 of 13 | PASS | 6fb064b7b |
| backfill of the outage | B (web) | REAL-TWO-HOST | same ticks in B's terminal buffer | 0 of 13 (B holds ticks 1..5 only); B is live afterwards: a marker typed after the reconnect reaches B | SPLIT (recorded, not a gate) | 6fb064b7b |
| same agent | A | REAL-TWO-HOST | `procs` on the claude process new to this run; no prompt, no login, no credential | pid 1926803 before and after, no relaunch (claude process count unchanged) | PASS | 6fb064b7b |
| same hook emitter | A | REAL-TWO-HOST | pid file and `kill -0` over ssh | pid 1927246 alive after | PASS | 6fb064b7b |
| status row for the same pane | A | REAL-TWO-HOST | `agentStatusByPaneKey` row for the hook pane's key | present before the drop, ABSENT from about 1.5 s after the carrier was restored until `connected`, present after; the store's two removal actions were not called (instrumented count 0) | PASS at the check point; continuity across the reconnect NOT held | 6fb064b7b |
| hook posted during the outage | A and B | REAL-TWO-HOST | script in the pane, remote epoch and curl exit in the root's hook log, store polled after reconnect | fired about 8 s into the outage (class `in`), curl exit 0, DELIVERED to both stores after reconnect (replayed; the client was detached when it fired) | delivered | 6fb064b7b |

Observations, not fixes:

- Outage-hook delivery depends on a condition this run did not characterize. In two earlier attempts on root 1 (logs kept, `15-03-root1/` and `15-03-run2-attempt*.log`) the same hook was LOST (curl exit 0, class `in`, not in either store within 60 s). In those attempts a command had been typed into the hook pane after its status row landed, and the row was already gone before the kill (the row-presence sampler of attempt 2 saw no row at all across 180 samples), consistent with the typed command clearing it but not proven. In the three runs where nothing was typed in the pane after the row landed, the hook was delivered. The ordering in the first two attempts is the one the plan text describes literally; the difference is not explained.
- The pane's status row disappears while the transport is being re-established and returns when the replayed hook arrives. With a row that is only restored by a replayed hook, "the row survives" is weaker than the plan's wording.
- Client B is not backfilled for the outage window although it is live afterwards.
- `recovery failed Error: terminal_liveness_unavailable` (twice per run): emitted by `refreshRestoredOrchestrationAuthority` with no connection id (src/main/runtime/orca-runtime.ts:4261-4273) when the local PTY controller inventory is unavailable; it is reached from `recoverLegacyWorkerTerminalsForRendererStartup` (src/main/startup/legacy-worker-renderer-recovery.ts, wired at src/main/index.ts:956), which calls `reconcile()` twice. In the log both lines precede the first `[ssh]` line and the carrier kill; none appears between the kill, the restore and the reconnect. It is app-startup noise unrelated to the reconnect; no source change.
- The first attempts' instrument defects (a process count polluted by other runs, a launcher that credits an earlier run's agent) were fixed in the test code before the recorded pair above; every attempt log is kept.

Containment. Witnesses equal before and after: known_hosts eee39ff279a28b40862a2a1e01e663a84d09d9c1527f9438fa8cda0ff014694f, `/home/kobii/orca-x` HEAD f9a721fda491096b74f0115d78632356e526d096, real-home `.orca-remote` listing absent. Root-scoped processes before teardown 9; after teardown `REMAINING=0`, `PROC_COUNT=0`, `SSHD_ALIVE=no`. No pairing link, token or private key is in this file.

## Verdict

Planes: LOCAL-HOST (only the laptop observes), REAL-SSH (a real handshake or command to GEX44), REAL-TWO-HOST (a real Orca on the laptop against a real relay on GEX44). SSH-DOCKER and localhost results were NOT used for any row below. The phase-2 runtime-environment leg (02-06, commit 84ca86e8c) is cited, not re-run (D-05).

| criterion | plane | evidence | verdict |
|---|---|---|---|
| Row 59, host-only legs: a second client opens a host-only project; fs, git and terminal act on the owning host; the laptop holds none of the content | REAL-TWO-HOST | Run 2: both clients, independent ssh reads, laptop absence scan with planted controls | PASS |
| Row 59, agent: launch placement and hook routing on the owning host (claim level: agent process + hook routing, NO model turn, OD-1 default taken) | REAL-TWO-HOST | Run 2 part a (real claude process, cwd = host-only repo) and part b (hook reaches both clients' stores) | observed; Codex is not offered on the SSH menu, so one provider; no model turn |
| Row 59, reconnect keeps work | REAL-TWO-HOST | Run 3: same relay, shell and agent, gap-free ticks, Client A backfill 13/13, ladder reconnect with a higher generation | PASS for the shell and the agent process; Client B not backfilled; status row absent while reconnecting; outage-hook delivery condition-dependent (delivered 3/3 clean runs, lost 2/2 in the earlier ordering) |
| Row 59 as a whole (D-15) | REAL-TWO-HOST | all of the above | PARTIAL: the D-15 gate (15-01 tracer, 15-02 legs, part a observed with a real provider, part b ok, reconnect run passed, outage hook delivered in the recorded run) is met in the recorded pair, but the outage hook was lost in two earlier attempts and the cause is not characterized, so "reconnect keeps work" is not shown without a condition; open: outage-hook delivery condition, no model turn (OD-1), Client B outage backfill, status-row gap while reconnecting, Codex absent from the SSH New-tab menu |
| Row 75, the two-host harness exists and ran | REAL-SSH for the provisioner, REAL-TWO-HOST for the spec | provisioner and driver committed; three recorded runs (Run 1 tracer, Run 2 row-59 legs, Run 3 reconnect) | PARTIAL (D-11: never PASS): rows 60 to 74 still owe a two-host exercise of their cross-host properties |

D-15 decision spelled out. Observed: terminal, fs, git from both clients; the real provider process launch; hook routing to both clients; the reconnect legs. NOT RUN: a model turn (needs a credential; none was copied or created). Row 59 is held at PARTIAL because an unexplained loss of the outage hook was measured twice, even though it was delivered in the three runs of the corrected ordering. Re-measuring this row to PASS needs one characterization of that condition (type nothing into the pane after the row lands versus the literal ordering), not new infrastructure.