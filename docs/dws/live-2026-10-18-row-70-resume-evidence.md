# Row 70 — Continue here resumes a Claude session on the SSH target (live, 2026-10-18)

Plane: REAL-SSH with a real model turn on both hosts. Laptop (Windows, e2e build, electron-headless)
to GEX44 through a private sshd that runs as the service account `orca-svc` with its real home (the
only home there holding a Claude login). Disposable root `/tmp/orca-hwf-p70-*`; `orca-dws-serve`
untouched (MainPID 3357463 before and after every run).

Command: `C:\Users\User\Apps\rbl\d4-p70.ps1 -Wt C:\Users\User\Apps\orca-rb-live-wt -Tag <tag>`
(provision, `svc-backup`, Playwright on `tests/e2e/hwf-two-host-continue-here-resume.spec.ts`,
then `svc-teardown`, `svc-restore`, witness compare). Product under test: session transfer
3987e6c4fa (spec `docs/dws/row-70-session-transfer-spec.md`); spec and harness at 55f1d7fbb6.

## Result: r70r5 — 1 passed (1.8 m), evidence `rbl\d4-ev-r70r5-20261018-135913`

| Leg                      | Observed                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Laptop session           | `HWF70R_LAPTOP_SESSION 38ee6b15-…` — a real `claude -p` turn in the laptop replica, told a secret word                      |
| One project across hosts | `HWF70R_PROJECT git-root:c617d1de… hosts=local,ssh:…`                                                                       |
| Disposition              | `HWF70R_PANES ["resume/provider-session-present"]` — resume planned only after the transfer's read-back                     |
| Independent instrument   | `HWF70R_TARGET XFER_BYTES=583529` — `stat` on GEX44 of `~orca-svc/.claude/projects/<enc cwd>/<id>.jsonl`                    |
| Open on the restored row | `claude --resume 38ee6b15-…` started on kobicraft-gex44 in the remote replica                                               |
| Resumed answer           | `HWF70R_RESUMED_ANSWER pelican2e5e` — the lowercase form of a word told only on the laptop; the question never contained it |
| Service home             | `CLAUDE_JSON_LEG_PROJECTS_REMOVED=1`, `HWF_CLAUDE_PROJECTS=0`, settings and agent hooks unchanged, `SVC_HOME_RESTORED=True` |
| Teardown                 | `REMAINING=0`, `PROC_COUNT=0`, witness unchanged                                                                            |

## Mutant: r70m — red at the instrument, evidence `rbl\d4-ev-r70m-20261018-140354`

`transferOne` returned `copied/present` without writing (working copy only, never committed; build
grep confirmed it in `out/main` before and absent after the restore rebuild). The product still showed
`resume/provider-session-present`; the GEX44 `stat` answered `No such file or directory` and the spec
failed at the `XFER_BYTES` assertion. Teardown clean, home unchanged.

## Red before green (all spec or harness; no product change)

- r70r (13:19): `asReplicaRun` requires `forkPath`; `seed-svc` seeds only the replica. Spec now reads
  `seedRoot`, `replicaPath`, `localReplicaPath`.
- r70r (13:26), r70r2, r70r3: resume started on GEX44 but sat on Claude's folder-trust dialog. r70r3's
  per-state log (`trust=false`, PTY id stable) showed the cause: the serialized Ink screen writes word
  gaps as cursor-forward (`CSI C`), so the text match never saw "trust this folder". Fixed by mapping
  `CSI C` to a space before `stripAnsiEscapeSequences`.
- r70r4: past trust, Claude asked to accept Bypass Permissions mode — the e2e profile's Yolo default
  launches with `--dangerously-skip-permissions`. Accepting that on the service account is the
  Owner's consent, not a test's: the spec now runs with Manual agent permissions and refuses to answer
  that dialog. r70r4 also exposed that `svc-restore` never touched `~/.claude.json`, where the trust
  answer left a project entry (removed by hand, exactly that key; login verified). The harness now
  removes only the leg's own `projects` keys (no byte restore: the serve keeps its login in that file)
  and reports `HWF_CLAUDE_PROJECTS`, which the driver compares.

## Not covered

- Yolo launch on the target: not exercised by design (above). Bypass mode was never accepted on
  `orca-svc` (`bypassPermissionsModeAccepted` absent).
- Agents other than Claude: the transfer refuses them (`not-transferable-agent`); no live leg.
- Windows SSH targets: `claudeTranscriptHomeRelativeDir` is POSIX-only; unit-tested refusal only.
