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