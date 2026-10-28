# STATE: DWS remaining live legs (rb-live)

## Current Position
Phase: 3 of 4 (Row 70 Continue here reattach)
Status: Ready to plan (Phases 1-2 complete; phase 2 sealed 0595f9e758, row 34 PASS, row 24 PARTIAL)
Last activity: 2026-10-17 rows 24/34 live leg r24h passed; earlier row 61 PASS (run r61c, matrix 28/76); earlier 2026-10-17 — roadmap created; row 74 PASS landed at d0b2d5988b

## Laws (read before every phase)
- You are ALREADY in the work tree `C:\Users\User\Apps\orca-rb-live-wt` (branch `rb-live`). Never call EnterWorktree/ExitWorktree.
- Windows host. git is `C:\Program Files\Git\cmd\git.exe` (prepend `C:\Program Files\Git\cmd` to PATH in every shell). GSD specialist subagents cannot run pnpm/git/node here (no PowerShell tool): run commands yourself or through a general-purpose agent.
- node_modules is a junction to `C:\Users\User\Apps\orca-ship-wt\node_modules`. Never `pnpm install` here, never delete the junction target.
- Live legs: driver `C:\Users\User\Apps\rbl\d4-live.ps1` (`-Wt <this wt> -Specs <spec> -Phase <NN> -SeedVerb <verb|none> -PathEnv <env|none> -Grep <title>`); provisioner `config/scripts/hwf-two-host-remote.mjs`; GEX44 disposable roots `/tmp/orca-hwf-p<NN>-*` only. Evidence under `C:\Users\User\Apps\rbl\` (short path: long paths break git).
- Every live run ends with teardown REMAINING=0, PROC_COUNT=0, witness unchanged. Check laptop free RAM >= 6 GB before an Electron run; do not launch while another e2e Electron run is live.
- NEVER commit `.claude/`, `LEARNINGS_PENDING.md`, `.pp-*`, `_audit_cache/` (hook/session artifacts) and NEVER force-add `.planning/` (it is git-excluded on purpose: tracked planning would land on the desktop PC's checkout). Commit only product files: specs, src, config, docs.
- Phase 2 has work in progress: `tests/e2e/hwf-two-host-mission-locality.spec.ts` (untracked, written by an earlier epoch). Read it and continue it; do not restart the phase from zero.
- Never touch the GEX44 `orca-dws-serve.service` unit or mission m-07a78fbae3c7. Any `orca serve` you start binds 127.0.0.1 only, with pairing, and you stop it yourself.
- A verdict keeps PASS / FAIL / NOT_RUN / HARNESS_FAILED apart. A zero needs a positive control showing the instrument can see a non-zero. Never stamp PASS on a row whose `done` is only partly measured.
- A product bug found by a leg: fix with a unit test that goes red first, a mutant, tsc + oxlint + oxfmt on touched files, then rerun the leg.
- Commits: pathspec-scoped, message from a file, verify `git log -1 --format=%s`. Push: `git push origin rb-live:refs/heads/orca-x/dws-rebaseline-live` fast-forward only; never force.
- After each phase append a dated update to `C:\Users\User\Apps\c0\RESUMPTION-lca.md`.
- 9 tsc errors in tests/e2e/helpers/store.ts and terminal.ts are pre-existing (config/tsconfig.tc.e2e-hwf.json); only new errors in touched files count.

## Phase 4 precondition (Owner, elevated, one time)
Small volume R: (512 MB NTFS VHD at C:\Users\User\Apps\rbl\smallfs.vhdx). Run the leg with `ORCA_HWF_SMALL_FS_ROOT=R:\hwf`. If R:\ is missing: HUMAN GATE, do not substitute a folder on C:.

## Accumulated Context
- Row 74 PASS (d0b2d5988b): equal-tips pair + sent-method tally (ORCA_E2E_RELAY_METHOD_TALLY=1) in tests/e2e/hwf-two-host-mixed-relay.spec.ts.
- Row 72 B harness: tests/e2e/hwf-two-host-mission-dispatch.spec.ts with serve-p22 / pairing-p22 / serve-stop-p22 verbs; missionPlace refused a local fingerprint bug was fixed in 6433969137.
- Row 17: GEX44 serve over loopback + `ssh -L` tunnel pairs fine; scp of an autocrlf .sh ships CRLF (normalize to LF).
- Matrix 27/76 PASS; `node config/scripts/check-dws-completeness.mjs` exits 1 by design (exit 2 = malformed evidence).

## Blockers/Concerns
- None for phases 1-3. Phase 4 waits on R:.
