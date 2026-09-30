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
