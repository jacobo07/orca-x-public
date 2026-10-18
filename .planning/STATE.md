# STATE: DWS rows 59, 24, 27, 17, 76, 52, 53, 54 (milestone 1, done) + milestone 2: re-measure 20 open rows

## Current Position
Phase: 8 of 12 (Re-measure ledger for all 20 rows) -- milestone 2 starts here
Status: Ready to plan. Milestone 1 phases 1-7 done: rows 59 24 27 17 76 52 53 54 PASS, matrix 41/76 at rb-live e3d4f35e8d (pushed).
Last activity: 2026-10-18 ~19:10 Owner pane: rows 24 and 17 live legs ran (RAM gate satisfied), S4-22 done in PP 465c6126, row 17 stamped; Owner "dale" added milestone 2 (phases 8-12) to ROADMAP.md. Phase 2/4 VERIFICATION files still say human_needed and their covered_digest is stale after the matrix edit: re-stamp them (status passed, the live legs ran: r24f d4-ev-r24f-20261018-175542, r17t2 d4-ev-r17t2-20261018-1828) before planning phase 8.

## MILESTONE 2 HAS 5 PHASES (8-12); THE ROADMAP HAS 12
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
## 2026-10-18 ~18:30 row 17 laptop ssh -L tunnel leg MEASURED (run from the Owner's pane, not by this worker)
- Worktree C:\Users\User\Apps\orca-p5-ft2-wt, detached 79f54d64af (src + lockfile == deployed 3266e1a), OWN node_modules (pnpm install; windows-native-registry native.node copied from orca-d4-x13r-wt, no VS). Runner config\scripts\dws-node-manifest-run.ps1 -FanOut, Git on PATH. No deploy.
- Run 1: memory/vram/resident_model MATCH, disk UNJUDGED control-unstable (GEX44 disk moved 3.1 GB during the run). Evidence C:\Users\User\Apps\rbl\d4-ev-r17t1-20261018-1825.
- Run 2: 4/4 MATCH (disk drift 12 MB < 1 GB), runtimeIdMatchesServe true, MainPID 3357463 unchanged, tunnelProcs 0, listeners 0, e2eElectron 0, serve active. Evidence C:\Users\User\Apps\rbl\d4-ev-r17t2-20261018-1828 (phase-5-node-manifest.json sha256 CD75A84A764B2B9C..), no pairing secret in it.
- Row 17 now owes ONLY UWCP S4-22: spec PP 5c57f4a4 (dws/pp-rows) vault/specs/uwcp-s4-22-node-adapter.md; AC-4 known_heads not met. Matrix row 17 NOT edited by the Owner pane: stamp it from this evidence.

## 2026-10-18 ~18:45 UWCP S4-22 DONE (Owner 'rec both')
- PP dws/pp-rows 465c6126 (on 5c57f4a4, both LOCAL, unpushed): node.py exposes known_heads per orca-node-manifest-1.schema.json (absent=None, non-empty list of non-empty strings, duplicates allowed). GSDX_NODE 23/23; mutants red (8b776241 code 8 gates, no validation 5, empty accepted 1).
- uwcp.md line 74: orca.node-manifest/1 supersedes KSR capabilities.json. Spec vault/specs/uwcp-s4-22-node-adapter.md status DONE, AC-1..6 MET.
- Row 17: both owed items now done (tunnel leg 4/4 MATCH + S4-22). Matrix row 17 still to be stamped PASS from this evidence.

## 2026-10-18 ~19:00 ROW 17 PASS pushed (Owner 'y')
- orca-x/dws-rebaseline-live d2d306d431..e3d4f35e8d (ls-remote verified): matrix row 17 PASS + docs/dws/live-2026-10-18-row-17-tunnel-{evidence.md,fanout.json}. Matrix 41/76 PASS; checker test 30/30.
- PP dws/pp-rows pushed 52c7ab29..465c6126 (S4-22 spec + known_heads).
- The matrix edit makes phase digests (04-VERIFICATION covered_digest) stale: re-stamp before trusting GSD phase status. Mission m-ba51631958f0's OWNER_BOUNDARY (free 6 GB for row 17) is now satisfied: nothing left for it on rows 17/24.

## D1 resolved (Owner 2026-10-18, worker epoch 2)
- RAM boundary resolved by the Owner pane: row 24 r24f PASS, row 17 r17t2 4/4 MATCH, S4-22 done in PP 465c6126, row 17 PASS at e3d4f35e8d. The earlier OWNER DECISION NEEDED (push dws/pp-rows) and the row 17 NOT_RUN note are superseded. Phases 1-7 VERIFICATION digests re-stamped. Do not re-run the row 17 or 24 legs. Continuing with milestone 2 from phase 8.
