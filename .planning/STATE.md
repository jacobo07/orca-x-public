# STATE: DWS rows 59, 24, 27, 17, 76, 52, 53, 54

## Current Position
Phase: 2 of 7 (Row 24 freshness window)
Status: Ready to plan (phase 1 complete: row 59 PASS, a98f54a5e3 + 36876b70e7 pushed, matrix 34/76)
Last activity: 2026-10-18 16:55 phase 1 verified; mission m-b8541432cbf9 HALTED no_progress because its worker declared "the milestone's only phase" done without writing SUMMARY/VERIFICATION

## THIS MILESTONE HAS 7 PHASES
A phase is complete only when every plan has its `NN-MM-SUMMARY.md` and the phase has `NN-VERIFICATION.md`
(status passed, `covered_digest` from `gsd-tools query verification.fingerprint <phase dir> <files...>`).
Then continue with the next phase in the same session. Never end a turn saying the work is finished while
`gsd-tools query init.manager` lists a recommended action.

## Owner decisions 2026-10-18 (binding)
- PP writes ONLY in `C:\Users\User\Apps\pp-dws-rows-wt` (branch `dws/pp-rows`, from feature/knowledge-acquisition 6ec221ff). Local commits, NO push. Never write in `~/.claude/skills/claude-power-pack` (shared checkout, 1191 foreign dirty files) or in pp-ucda-wt.
- Row 24 freshness window: 7 days. Stale ready setup = unhydrated, never ineligible.
- Row 27 bake-off: local qwen3-coder-30b (GEX44 :8081) vs Claude as orca-svc, same fixed prompt set, same scorer.
- Row 59 model turn: orca-svc harness, Manual agent permissions. NEVER accept the Bypass Permissions dialog (that consent is the Owner's).

## Laws (read before every phase)
- You are ALREADY in `C:\Users\User\Apps\orca-rb-live-wt` (branch `rb-live`). Never call EnterWorktree/ExitWorktree. Reach the PP worktree by absolute path.
- Windows host. git is `C:\Program Files\Git\cmd\git.exe` (prepend `C:\Program Files\Git\cmd` to PATH in every shell). GSD specialist subagents cannot run pnpm/git/node here: run commands yourself or through a general-purpose agent.
- node_modules is a junction to `C:\Users\User\Apps\orca-ship-wt\node_modules`. Never `pnpm install`, never delete the junction target.
- e2e build: `$env:VITE_EXPOSE_STORE='true'; .\node_modules\.bin\electron-vite.cmd build --mode e2e`, then Playwright with SKIP_BUILD=1. After a product change, rebuild before any live leg and grep `out/main` for the change.
- Live legs: drivers in `C:\Users\User\Apps\rbl\` (`d4-live.ps1`, `d4-p70.ps1` for orca-svc legs); provisioner `config/scripts/hwf-two-host-remote.mjs`; GEX44 disposable roots `/tmp/orca-hwf-p<NN>-*` only. Evidence under `C:\Users\User\Apps\rbl\`.
- orca-svc legs: the driver must end with `SVC_HOME_RESTORED=True` and `HWF_CLAUDE_PROJECTS=0`. Reading Claude's TUI: map CSI `\u001b[<n>C` to a space before `stripAnsiEscapeSequences` (Ink writes gaps as cursor moves).
- Every live run: teardown REMAINING=0, PROC_COUNT=0, witness unchanged. Laptop free RAM >= 6 GB before an Electron run; one Electron e2e at a time.
- Never touch the GEX44 `orca-dws-serve.service` unit (read-only probes and tunnels to 127.0.0.1:6791 are fine) or missions m-07a78fbae3c7, m-3f1feb210a74, m-0a2b4dad289b.
- NEVER commit `.claude/`, `LEARNINGS_PENDING.md`, `.pp-*`, `_audit_cache/`, and NEVER force-add `.planning/`.
- A verdict keeps PASS / FAIL / NOT_RUN / HARNESS_FAILED apart. A zero needs a positive control. Never stamp PASS on a row whose `done` is only partly measured; a row whose remaining gap is outside this program stays PARTIAL with the gap named.
- A product bug: unit test red first, a mutant, tsc + oxlint + oxfmt on touched files (`config/tsconfig.tc.e2e-hwf.json` has 9 pre-existing errors in helpers/store.ts and terminal.ts), then rerun the leg.
- Matrix edits: never run oxfmt on `config/dws-completion-matrix.jsonc` (HEAD is not oxfmt-formatted: it rewrites ~500 lines). Edit by exact string replacement; check with `node config/scripts/check-dws-completeness.mjs` (exit 1 by design, 2 = malformed) and `.\node_modules\.bin\vitest.cmd run config/scripts/check-dws-completeness.test.mjs`.
- Orca commits: pathspec-scoped, message from a file, verify `git log -1 --format=%s`. Push at phase end: `git push origin rb-live:refs/heads/orca-x/dws-rebaseline-live`, fast-forward only, never force; verify with ls-remote.
- PP commits: pathspec-scoped in pp-dws-rows-wt, PP hooks ON (never `-c core.hooksPath=`), PP tests in V-* style run with `C:\Users\User\AppData\Local\Programs\Python\Python312\python.exe`.
- After each phase append a dated update to `C:\Users\User\Apps\c0\RESUMPTION-lca.md`.

## Accumulated Context
- Row 70 PASS (55f1d7fbb6, bf703ebaae): `tests/e2e/hwf-two-host-continue-here-resume.spec.ts` is the model for an orca-svc model-turn leg (session made, Manual mode, trust dialog answered per poll, nonce answer).
- Row 59 evidence so far: docs/dws/live-2026-10-15-row-59-remote-first-evidence.md (6/6 legs, no model turn).
- Row 24 caveat: `runtime.listProjectHostSetups` setupState ready counts, `updatedAt` never read (r24h, r24r).
- Row 17: Orca producer MATCH at 3266e1a; `modules/gsd_x/goal/node.py` does not exist in the PP; laptop tunnel leg never ran (RAM was 1.37 GB then).
- PP tower: 4 families (kobiicraft_mode, persistent_state, web_surface, wii_homebrew); `tools/family_baseline.py`, `modules/tower/ratchet.py` exist.

## Blockers/Concerns
- None known. A genuine Owner question ends the turn with `HUMAN GATE: <one concrete question>`.

## Decision 2026-10-18 (epoch 2)
- Row 24 live leg stays NOT_RUN: laptop free RAM 4.4 GB < 6 GB gate (many claude/Cursor/brave procs belong to the Owner; not mine to kill). Phase 2 = human_needed on RAM only; rerun the command in 02-VERIFICATION.md when free RAM >= 6 GB. Moving on to Phases 3-7 which need no Electron run on the laptop.
- Phase 4 finding: UWCP S4-22 is defined nowhere in the Orca repo or pp-dws-rows-wt (only cited as 'goal/node.py consumer' in config/scripts/dws-node-manifest-evidence-write.mjs and the matrix); modules/gsd_x/goal/node.py does not exist. Laptop tunnel leg is Electron => same 6 GB RAM gate as row 24.
- Phase 3 decision: Claude side runs as kobii (claude -p on GEX44; orca-svc has no sudo path from kobii) - recorded as a deviation in the result doc.

## Decisions (rb-live DWS rows milestone, worker epoch 2, 2026-10-18)
- Rows 59, 24, 76, 52, 53, 54 stamped PASS in config/dws-completion-matrix.jsonc (checker 40/76, vitest 30/30). Row 27 passed in phase 3. Row 17 stays PARTIAL: the laptop-to-GEX44 tunnel leg is NOT_RUN (free RAM 1.64 GB against the 6 GB gate); UWCP S4-22 is defined nowhere, so goal/node.py matching it is unconfirmed. Rerun: fan-out spec over ssh -L when free RAM >= 6 GB.
- Row 54 promoted two standards (bypass consent never answered, transfer read back on the target) into multi_host_fabric B1 through ratchet.promote. The Ink CSI C trap was not promoted: its fix is in the live-leg harness outside this repo, so no check here can witness it.
- PP commits 8b776241, 18bc67aa, a1f5f45b, 52c7ab29 on branch dws/pp-rows in pp-dws-rows-wt are LOCAL and unpushed. OWNER DECISION NEEDED: push dws/pp-rows to the PP remote (outward-facing). My pick: push after reviewing; nothing in this repo depends on the push.
- Phase digests were re-stamped after the last matrix edit; any further matrix edit makes them stale again.