# Phase 20: environment contract and Prepare this device, evidence

Rows 68 and 69 of the DWS completion matrix ask whether a project's `orca.yaml` requirements are
measured on the host that runs it (local, SSH and runtime hosts), and whether the Prepare this
device plan shows every state, runs only approved, unchanged, same-host steps, and lets no secret
reach the laptop. Row 75 asks for those cross-host properties to be exercised Windows <-> GEX44
over real SSH. The authority is the STATE.md two-host authorization: this laptop's Orca may talk to
a GEX44 disposable root only (`/tmp/orca-hwf-p20-*`, throwaway HOME, loopback private sshd), never
to kobii's real home, never to the shared `orca-dws-serve` service and never to the VPS.

Plane names: LOCAL-HOST (only the laptop observes), REAL-SSH (a real ssh command to GEX44),
REAL-TWO-HOST (a real Orca on the laptop driving a real relay on GEX44), REAL-RUNTIME (a real
`orca serve` on GEX44 answering its own CLI), CODE_VERIFIED (unit and component tests only).

**Status: L1-L6, R1 and O1 observed on real planes. L6 was RED in Runs 5 and 6 (an unreachable
SSH host read `contract-unreadable`, not `unreachable`); the product fix b6411fa6f landed and Run 7,
built from it on a fresh root, passed all six legs (`1 passed, 1 skipped`).** The copy below is
Owner-reviewable.

## Rung

| item | value |
|---|---|
| harness commit | 79ec9c0b6 (`seed-p20`, `edit-prepare-p20`, `stat-shim-p20`, `serve-p20`, `serve-query-p20`, p20 guard) |
| spec commit S | 38e1ab4b9 |
| harness/spec fixes | cafdc637f, 395ea3d08, de145726b, 83a884fcf, 25337e067 (each named below) |
| product under test | 20-03 HEAD 01acd5e7c for Runs 1-6 and O1 (src identical at each); Run 7 built from b6411fa6f (01acd5e7c plus the L6 fix) |
| local relay version | 0.1.0+09638ea5d265 (built from S's tree; the Run 7 rebuild from b6411fa6f reads the same version) |
| old relay version (O1) | 0.1.0+c1eb18e241d9 (built from 20-01's pre-plan sha 5de29754c) |
| disposable roots | `/tmp/orca-hwf-p20-20261001T231448Z`, `...T233655Z`, `...T234222Z`, `...T234707Z`, `/tmp/orca-hwf-p20-20261002T000826Z` (Run 7) (one fresh root per run that mutates the contract or the shim; all left in place) |
| remote hostname | kobicraft-gex44 |
| decisive runs | Run 7 (Test A, all six legs), O1 run (Test B); Runs 5 and 6 for the L6 RED |

The guard: the provisioner's `case` refuses a bare `/tmp/orca-hwf-p20-` and any non-alphanumeric
tail, accepts `/tmp/orca-hwf-p1[56]-*` and `/tmp/orca-hwf-p20-*`, and refuses everything else; the
driver regex is `^\/tmp\/orca-hwf-p(?:1[56]|20)-[0-9A-Za-z]+$`. The committed refusal drill
(29 DRILL lines, re-run by the verifier with an identical result) refuses `p17`, `p21`, bare,
`..`, `;id`, `/` suffix and `/tmp/not-ours` on both sides for p16 and p20 shapes, gives exit 3 for
a valid-shaped missing root, refuses `seed-p20` on a bad root, and accepts `new-nonce` and
`new-root --phase 20`.

## Seeded contract

`seed-p20` writes `<root>/repos/p20-project/orca.yaml` (a git repo) with seven requirements, the
shim `prepare` as a `|` block scalar (N1), and `<root>/home/.profile` exporting a laptop-minted
token (`HWF20TOK_` + a 16-hex nonce that lives only in the run file) and prepending
`$HOME/p20-bin` to PATH. The private sshd login shell sees both (`LOGIN_HAS_P20_BIN=yes`,
`LOGIN_HAS_TOKEN=yes`, presence only; no remote verb prints the token).

| id | kind | declared | expected state |
|---|---|---|---|
| git-ok | command | `git`, `>=2.25` | satisfied |
| git-too-new | command | `git`, `>=99` | incompatible |
| absent-tool | command | `orca-hwf-p20-absent-tool` | missing |
| mac-only | command | `git`, `platforms: [{os: darwin}]` | unsupported |
| shim | command | `orca-hwf-p20-shim`, with a `prepare` that writes it into `$HOME/p20-bin` | needs-authorization |
| gpu | gpu | (kind not evaluated by this Orca) | unknown |
| token | env | `ORCA_HWF_P20_TOKEN` | satisfied |

`CONTRACT_SHA256=6935e5f36d0b25b30e0e4ab7f6f6482f61096eb15078aa715b0773b531660185` on every root
(same bytes); `PREPARE_SHA256` of the parsed shim value `8d7a6961...a71f`.
`edit-prepare-p20` appends a command line inside the block scalar and prints a changed parsed hash
(N1), so a no-op edit is caught before the spec runs.

## Legs

| leg | plane | instrument | observed value | verdict | commit |
|---|---|---|---|---|---|
| refusal drill | REAL-SSH + LOCAL-HOST | committed `hwf-two-host-refusal-drill.mjs`, exit codes only | 29 DRILL lines, verifier re-run identical | PASS | 79ec9c0b6 |
| zero repos | REAL-TWO-HOST | `window.__store.repos.length` in a fresh profile | `HWF20_ZERO_REPOS=yes` | PASS | 38e1ab4b9 |
| relay fence | REAL-SSH | local `.version` against `ls home/.orca-remote` | `match local=remote=0.1.0+09638ea5d265` | PASS | 38e1ab4b9 |
| host identity before any prepare leg | REAL-TWO-HOST | product `resolveSshHostIdentityStatus` over the saved target and main's live state (what the prepare authority reads) | `HWF20_IDENTITY=pinned live=absent` | PASS | 395ea3d08 |
| L1 measure (SC1 SSH, SC2 states) | REAL-TWO-HOST | station `[data-prepare-device-section]`, user Measure click, `data-requirement-state`; `measureRequirements` response; `git --version` over ssh | all seven states exactly as seeded; `os=linux`; `gitVersion=2.43.0 independent=2.43.0`; `contract=6935e5f3...0185` = seed; header names `ssh:<target>@<tag>` and the sha8 (Run 6 hostKey `ssh:ssh-1790898449815-kgvtmp@a29084c04f665a35`; Run 7 `ssh:ssh-1790899779769-1ry6xw@b915ed229487e13c`) | PASS (Runs 3-7) | 38e1ab4b9 |
| L3 stale approval | REAL-TWO-HOST + REAL-SSH | plan rendered (station `data-prepare-run=shim`), `edit-prepare-p20` on GEX44, approve through `PrepareStepApprovalDialog` from the stale plan; shim stat over ssh | `reason=contract-changed shim=no` | PASS | 38e1ab4b9 |
| L4 other-host approval | REAL-TWO-HOST + REAL-SSH | `window.api.environment.runPrepareStep` with a hash for `local@<laptop tag>` over the current bytes | `reason=approval-for-another-host shim=no` | PASS | 38e1ab4b9 |
| L2 approved step, decided by a re-measure | REAL-TWO-HOST + REAL-SSH | user Measure (shim back to needs-authorization for the new bytes), approve and run, terminal tab store read, shim stat polled, then Settings reopened and a user Measure | `terminal=tab-present started=yes shim=present row=satisfied decidedBy=remeasure startedSignal=terminal-activated rowBeforeRemeasure=none` | PASS | de145726b |
| L5 no secret on the laptop | LOCAL-HOST (laptop files) after REAL-TWO-HOST traffic | phase-15 `scanLaptopForContentNonces`, unchanged, over userData, recent temp and a capture dir (every measure/run response, the CLI `project requirements --json` output, a store dump); scanned after the app exited | `HWF_ABSENCE verdict=PASS control=found hits=0 files=40848 unreadable=0` (Run 6), `files=40886 unreadable=0` (Run 7); `envRow=satisfied cli=ok` | PASS | 83a884fcf |
| L6 unreachable host | REAL-TWO-HOST | carrier killed, user Measure, row handles; `measureRequirements` response | Run 7: `rows=1 unknownNoObservation=1 missing=0 reasons=unreachable:1` with the response `contract=unreadable status=unreachable`. Runs 5-6 (before the fix): `reasons=contract-unreadable:1` | PASS (Run 7); FAIL (product) in Runs 5-6 | 25337e067, b6411fa6f |
| R1 runtime host measures itself (SC1 runtime) | REAL-RUNTIME | disposable `orca serve` (loopback, `--no-pairing`, HOME and userData inside the root) from a GEX44 worktree fenced to 01acd5e7c; `orca repo add` + `orca project requirements --json` run on GEX44 | `HWF20_R1 status=measured hostKey=local@c0d6078e9c767e3a os=linux gitVersion=2.43.0`, `INDEPENDENT_GIT=2.43.0`; tag differs from every laptop tag | PASS | 79ec9c0b6, 395ea3d08 |
| O1 old relay | REAL-TWO-HOST | Test B with `ORCA_RELAY_PATH` at a relay built from 5de29754c | `HWF20_O1_RELAY=0.1.0+c1eb18e241d9`; `rows=7 unknownPredates=7 missing=0`; `1 passed (49.9s)` | PASS | 38e1ab4b9 |
| local laptop measurement (SC1 local) | LOCAL-HOST | 20-01 T2 real probe (`20-01-local-real.txt`) | `git=C:\Program Files\Git\cmd\git.exe version=2.52.0`, absent command absent, `pnpm.cmd` failed/version-probe-needs-shell | PASS (cited, not re-run) | 4b444ada0 |
| WSL leg | LOCAL-HOST | 20-01 | `WSL_LEG=NOT_RUN reason=no-distro` | NOT_RUN | 4b444ada0 |
| unit layers | CODE_VERIFIED | 20-01 parser, probe core, relay handler, measurement; 20-02 classifier, plan, authority, runner; 20-03 store write, dialog, presenter, section, CLI | see the plan summaries | cited, never re-labelled | faf51a8ed 4b444ada0 0f7147427 6a140c0d3 1b51350f6 accab0819 efa7a3a33 74a518ac4 ec6c2b677 0149d3b16 01acd5e7c |

L2's terminal evidence is `tab-present`: a store read of the `Prepare: shim` tab, not a rendered
observation. Its started signal is the activated terminal, not the section's started note: the
runner creates the terminal with `activate: true`, which leaves Settings and unmounts the section,
so `data-prepare-step-started` is never seen after an approve-and-run (Run 3). The terminal exists
only after the authority passed, and the shim appeared on GEX44 within the poll.

L6 reason distribution: Run 7 `unreachable:1`; Runs 5 and 6 (identical) `contract-unreadable:1`.
Zero `missing` in every run, so the host is never read as absent. The only row is the contract
row: with the contract unread there are no per-requirement rows to render. Since b6411fa6f that
row names the host status, which is what the plan's "every GEX44 row unknown with reason
unreachable or timed-out, zero missing" asks; the spec assertion was not changed.

## L6 RED reproduction (Runs 5-6; fixed by b6411fa6f, PASS in Run 7)

1. Add an SSH repo whose `orca.yaml` declares requirements; Measure in Settings: seven rows.
2. Kill the SSH transport (here the `ssh -L` carrier), then click Measure again.
3. Observed: one row, `data-requirement-id="orca.yaml"`, `data-requirement-state="unknown"`,
   `data-requirement-reason="contract-unreadable"`. The measurement response itself carries
   `measurement.status = "unreachable"` beside `contract = "unreadable"`.

Cause (read, CODE_VERIFIED): `readContract` in `src/main/environment-requirement-measurement.ts`
maps every non-ENOENT read error, including a dead SSH filesystem provider, to `unreadable`, and
`buildPreparePlan` shows `classifyContractRead` in place of the requirement rows. A transport
failure is collapsed into a file failure. Fix b6411fa6f: `classifyContractRead` takes the host
status, so an unreadable contract on an unmeasured host reads `unknown(<status>)`; a measured host
keeps `contract-unreadable`. Run 7 observed `reasons=unreachable:1`.

## Runs

| run | root | result | what stopped it |
|---|---|---|---|
| 1 | 231448Z | 1 failed | harness: identity read from the renderer mirror, which carries no hostIdentity |
| 2 | 231448Z | 1 failed | harness: main's public SSH state carries no hostIdentity either (fixed by reading it through the product resolver, 395ea3d08) |
| 3 | 231448Z | 1 failed | harness: L1, L3, L4 observed; L2's step started (shim created) but the section's marker unmounted on terminal activation (de145726b) |
| 4 | 233655Z | 1 failed | harness: L1-L4 and L2 observed; L5 INCONCLUSIVE (hits=0, control found) because Chromium holds `Network/Cookies` and its journal exclusively while running (83a884fcf scans after exit) |
| 5 | 234222Z | 1 failed | product: L1-L5 observed, L5 PASS; L6 RED |
| 6 | 234707Z | 1 failed | product: L1-L5 observed again, L6 RED with the measurement's own status recorded |
| O1 | 234707Z | 1 passed, 1 skipped | none |
| 7 | 20261002T000826Z | 1 passed, 1 skipped | none: built from b6411fa6f; L1-L6 all observed (verifier `LEGS_OK 20-04-run7.log`) |

Logs are kept whole in the phase dir (`20-04-run{1..7}.log`, `20-04-o1.log`, `20-04-runtime-leg.txt`).
The T3 verifier over Run 7 (`20-04-verify-t3-run7.cjs`, the Run 6 copy pointed at `20-04-run7.log`)
prints `LEGS_OK`.
The T3 verifier over Run 6 reports only `not-1-passed`, `failed-or-flaky` and `L6`; every other
check (identity, L1-L5, R1, O1, the log scans for private-key armour, the token prefix and the
sentinel, and the remote-body bans) passed.

## Containment

Before teardown each root held its sshd and the relay processes (3, 3, 3 and 4). After `teardown`
every root reads `REMAINING=0`, `PROC_COUNT=0` and `SSHD_ALIVE=no` (roots kept, not refused).
Run 7's root held 3 (sshd, relay, relay shell) and reads the same after teardown, with its own
witness pair (`20-04-run7-witness-{before,after}.txt`) equal. No
process carries a HOME or userData under a p20 root. Witnesses before and after are equal:
`KNOWN_HOSTS_SHA` (kobii's real known_hosts), `ORCA_X_HEAD` f9a721fda, `REAL_RELAY_LISTING_SHA`
absent. The disposable serve ran in its own session and was stopped by session (6 processes before,
0 after); the real `~/.codex/hooks.json`, `~/.codex/config.toml` and `~/.claude/settings.json` keep
mtimes older than the run. The GEX44 worktree `/home/kobii/orca-p20-20261001T231448Z` (fenced to
01acd5e7c via `refs/heads/dws-p20-38e1ab4`) and the laptop worktree for the old relay are left
registered.

## What this phase does not claim

- No Orca-originated installs (OD-2 a): Orca only runs text a project declared.
- Referenced script content is not covered by an approval; the approval names the command line.
- The relay's environment and a terminal's environment can differ; `env` is measured through the
  login shell the relay would use.
- Windows ARM arch is not measured here.
- Setup-trust at the effect is still renderer-only (unchanged by this phase).
- `detectRemoteAgents` still collapses unreachable into empty (named debt; the new path does not
  use it).
- WSL: `WSL_LEG=NOT_RUN reason=no-distro` (20-01).
- W6: runtime-host prepare, local prepare and folder-workspace prepare are LOCAL-HOST units only,
  not observed REAL. R1 measures a runtime host; it runs no prepare step. The folder-repo workspace
  selector `id:<repoId>::<repo.path>` is still inferred for folder repos; L2 confirmed it only for an
  SSH git repo root.
- B1: `contract differs on <host>` is LOCAL-HOST (component test with two mocked hosts) only, and the
  D-09 no-replica source preference is deferred to phases 17-19.
- W4: on a runtime host the approval is the caller's; it is not recorded host-side.
- L6 covers an unreachable host only (carrier killed); a timed-out host was not driven REAL.
- N6: the approval write is an in-memory update with a debounced save, not crash-durable.
