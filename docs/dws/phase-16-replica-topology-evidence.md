# Phase 16: logical workspace identity and replica topology, evidence

Rows 60 and 61 of the DWS completion matrix ask whether a remote-less repo on two hosts becomes one Project, and whether the UI and the CLI list each replica with its host and role. Row 75 asks for those cross-host properties to be exercised Windows <-> GEX44 over real SSH. The authority is the STATE.md two-host authorization: this laptop's Orca may talk to a GEX44 disposable root only (`/tmp/orca-hwf-p1[56]-*`, throwaway HOME, loopback private sshd), never to kobii's real home and never to the VPS.

Plane names: LOCAL-HOST (only the laptop observes), REAL-SSH (a real ssh command to GEX44), REAL-TWO-HOST (a real Orca on the laptop driving a real relay on GEX44).

**Status of this run: STOPPED at a product rung (D-20).** L1, L3A and L4A were observed and pass. L2 failed on one product assertion (below); L3B, L4B, L5 and the L5 pending sub-leg did not run. The matrix was NOT edited: rows 60, 61 and 75 keep their previous text until a product fix is decided and the run is repeated.

## Run 5 (16-05): one REAL-TWO-HOST run

| item | value |
|---|---|
| harness commit | 28eaff96a |
| spec commit S | fb6ab915d |
| disposable root | /tmp/orca-hwf-p16-20261001T151845Z (left in place) |
| remote private sshd | 127.0.0.1:42987 (loopback only) |
| laptop local forward | 127.0.0.1:47216 (ssh -L over the `gex44` alias) |
| host key fingerprint (ssh-keygen -lf) | SHA256:Cbj/uuMhZUOgHiaeO/8OWT4ggup6PpCbpby4eEKQ/N8 |
| remote hostname | kobicraft-gex44 |
| local relay version | 0.1.0+c1eb18e241d9 |
| remote `home/.orca-remote` listing | relay-0.1.0+c1eb18e241d9 |
| run log | `16-05-run1.log` (phase dir), 7.8 min, `1 failed` |

### Seed and equality gate

Both hosts build the first commit of `p16-replica` from one recipe: one `git -c` set (`core.autocrlf=false`, `core.safecrlf=false`, `commit.gpgsign=false`, `core.hooksPath=`, `init.defaultBranch=main`, `user.name/email=hwf16`) on init, add and commit, author and committer name, email and date fixed through the environment, and `seed.txt` = `HWF16_<nonce>\n` with LF bytes. Nonce `b0682a625acc4368`.

| side | SEED_ROOT | head after the host-specific commit |
|---|---|---|
| GEX44 (`seed-p16`, git 2.43.0) | 5a82d7376571dbc6bc7470e2e4eb187704b136cb | 7da44efc995207cbad5cf818ef7ac4eef6dcc460 |
| laptop (`seed-local-p16`, Git for Windows) | 5a82d7376571dbc6bc7470e2e4eb187704b136cb | 6431785f51004af8d673dc4db03f17e0aad2431d |

Equal, so the legs ran. GEX44 also holds a fork (local clone, origin removed, one commit, head ef7d6928), a `--depth 1` shallow clone (`SHALLOW_IS_SHALLOW=true`), an unborn repo and a late repo.

### Leg table

| leg | plane | instrument | observed value | verdict | commit |
|---|---|---|---|---|---|
| root guard + refusal drill | LOCAL-HOST + REAL-SSH | committed `hwf-two-host-refusal-drill.mjs`, lines derived from exit codes, re-run by the verify | driver and remote `.sh` refuse p17, bare, `..`, `;id`, `/` suffix, `/tmp/not-ours` (exit 2); nonexistent p16 root `no-root` exit 3; bad-root `seed-p16` refused; `new-nonce` and `seed-local-p16` ACCEPTED exit 0; first run and re-run identical | PASS | 28eaff96a |
| git rung | REAL-SSH | `git-compat-p16` on the host git and on Git 2.25.5 built in the root | both versions: replica `false|.git`, root log = SEED_ROOT, refs = head; shallow `true|.git`, root log = shallow head; unborn root log exit 128, refs empty. 2.25.5 adds a stderr warning `ignoring broken ref refs/remotes/origin/HEAD` on the shallow clone | PASS | 28eaff96a |
| zero repos at start | REAL-TWO-HOST | `window.__store.repos.length` in a fresh-profile Orca | `HWF16_ZERO_REPOS=yes` | PASS | fb6ab915d |
| trust pin | REAL-TWO-HOST | phase-14 first-contact dialog, `listTargets().hostKeyPin` | `HWF16_PIN` equals the ssh-keygen fingerprint | PASS | fb6ab915d |
| relay fence | REAL-SSH | local `.version` against `ls home/.orca-remote` | `HWF16_RELAY_FENCE=match` | PASS | fb6ab915d |
| L1 one project across hosts (SC1) | REAL-TWO-HOST | connected gate, then list calls every 5 s bounded at 390 s; store `projects` / `projectHostSetups` | `HWF16_L1 project=git-root:5a82d737... repos=<laptop>,<gex44> setups=local,ssh:<target> waitedMs=5067`: the first probe did not lose the race (5 s, far under the 5 min miss TTL) | PASS | fb6ab915d |
| L3A Settings rows (SC2 UI) | REAL-TWO-HOST | `[data-replica-topology-section]` station, then `data-replica-membership` / `data-replica-host-health` | `HWF16_L3A station=ok grouped=2 sshHealth=reachable` (host-health positive control) | PASS | fb6ab915d |
| L4A CLI (SC2 CLI) | REAL-TWO-HOST | built `out/cli/index.js project setups --project <id> --json` against the e2e app's runtime (`ORCA_USER_DATA_PATH` = its userData) | `HWF16_L4A plane=REAL-TWO-HOST replicas=2 hosts=local,ssh:<target>`, each with hostId, provenance and membership | PASS | fb6ab915d |
| L2 same-host fork kept apart (SC1 collision) | REAL-TWO-HOST | fork, shallow and unborn added over ssh, list calls every 5 s for 394 s | see characterization below | FAIL (product) | fb6ab915d |
| shallow / unborn controls | REAL-TWO-HOST | store `gitRootIdentity` / `gitRootIdentityNoneReason` | shallow `null` + `shallow`; unborn `null` + `unborn` (settled inside the L2 wait) | observed, leg not completed | fb6ab915d |
| L3B, L4B, L5, L5-pending | - | - | not reached | NOT RUN | - |
| containment | REAL-SSH | witnesses before and after, `procs` after teardown | witnesses equal; `PROC_COUNT=0`; `status` after teardown `SSHD_ALIVE=no` (root kept) | PASS | - |

### L2 characterization (product rung, not fixed here)

After the fork was added, the GEX44 copies were split as phase 16 intends at the SETUP level, but the Project catalog did not follow. State seen on the last of the list calls (394 s):

- `projectHostSetups`: the laptop setup keeps `git-root:5a82d737...`; the GEX44 replica setup and the fork, shallow and unborn setups each carry `repo:<own id>`.
- `projects`: ONE row, `git-root:5a82d737...`, whose `sourceRepoIds` still lists BOTH the laptop repo and the GEX44 replica. There is no `repo:` Project row for any of the four GEX44 setups.
- shallow and unborn settled with their reasons.

So two facts disagree: the replica's setup says it left the git-root project, the git-root project still claims it, and four setups name projects the catalog does not hold. The plan's L2 truth ("neither id is in the git-root project's sourceRepoIds") is not met. `mergeProjectRepo` (`src/shared/project-host-setup-projection.ts:144-157`) only ever appends to `sourceRepoIds`; whether the persisted Project row should be pruned or re-derived when a member's key changes from `git-root:` back to `repo:` is a product decision for the orchestrator. Per D-20 no product fix was improvised and the run was not repeated.

## What this phase cannot know

- D-06: a fork on ANOTHER host (one candidate per host, same first commit, different later history) cannot be told from a diverged replica without comparing objects across hosts. Phase 16 groups it with relation `unverified`; the ancestry check is row 63 (phase 17), and the verdict and split are rows 66-67 (phase 19). This caps row 60 at PARTIAL even when every leg passes.
- D-15 scope asymmetry: the Settings surface merges replicas across every connected host, while `orca project setups` lists one runtime's replicas; replicas owned by other paired Orca servers are not listed by the CLI and no phase owns that fan-out.

## LOCAL-HOST unit evidence cited, not re-run

16-01 root probe and persisted `Repo.gitRootIdentity` (b2924e078, 9d17ec3d9, 6a3fac3e4, 25f3502d0); 16-02 provider-identity extraction, collisions, setup refusal, old-client gate and key switch (f71a7fe83, 025b9a1ff, 2c88718d2, d528e3fa0, d58063830); 16-03 succession and id remaps (c01a11126, 44a466dd7); 16-04 topology, CLI, host health and Settings (e97dca8fd, 0fcc04c09, 290e9fc4b, e13591a87). These are LOCAL-HOST claims and keep that label.
