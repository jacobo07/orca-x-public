# RESUMPTION — Orca X Agent Federation (worktree `C:\Users\User\Apps\orca-federation-wt`)

## 1. Identity
Branch `orca-x/agent-federation`, created 2026-09-24 from `orca-x/cogws-product-surface` @ `591ab8986`
plus a merge of `orca-x/aeos` @ `f9a721fda`. Thesis: Orca already has a mission graph
(`src/main/runtime/orchestration/`, upstream, on main) and a durable agent roster (cogws). They
never meet — orchestration addresses terminal handles. This program joins them; it builds no
second mission system, no second approval system, no second audit log.
Owner approved (2026-09-24): PLAN MODE; Claude driver YES; do NOT register ÁGORA/Hermes/Kados/KEOS
(none are runtimes — memory `orca-x-agent-federation-reality-scan`); GEX44 local runtime IN scope (P8).

## 2. State
- **P0 SEALED** `a97d3bcc0` (merge). 4 conflicts resolved; 4 lint-only gates wired into pr.yml.
  GEX44 at exact rev: 10 gates rc=0 (ci-gate-coverage 33/33 invoked, 0 debt), tsc node 0 errors,
  scoped suite `src/main/runtime/orchestration src/main/conversation` + 2 daemon files =
  **584 passed / 9 skipped, 66 files**. That is the attribution baseline for P1+.
- GEX44 evidence worktree: `/home/kobii/fed-wt` (detached, fed by `git push gex44:orca-x
  HEAD:refs/federation/head`; assert REV before trusting). `gex44` is an ssh URL, not a remote name.
- Coherence anchor: `git log --format=%s -1 a97d3bcc0` = "merge(federation): join the agent roster...".
- This branch's `RESUMPTION_FILE.md` is the cogws program's (inherited, tracked) — never edit it here.
- **P1 SEALED** `b29103907` (characterization). **P2a SEALED** `77f3df5e5`: v30 task columns
  `assignee_agent_id`/`requester_agent_id`/`subject`; `delegation-bounds.ts` judges every agent
  delegation in `createTask` (depth>6, fan-out>=12, A->B->A, requester must hold the parent, no
  agent-started root). GEX44 @77f3df5e5: migration gate ok, tsc 0, orchestration+conversation
  suite green, 6/6 mutations CAUGHT (registry drop caught by the GATE, not by tests — by design).
  The static migration gate cannot see columns added in a loop: write one explicit ladder step each.
- **P2b SEALED** `2e0546d8d`+`aef4c0066`: agent-assigned tasks leave the terminal pool and run as the
  agent's turn (`coordinator-agent-tasks.ts` -> registry runner -> `agent-task-execution.ts` ->
  `runConversationTurn`, SAME deps object as the conversations IPC). Result = `tasks.result`
  `orca.agent-task-result/1`; completion promotes dependents. Subject in another project refused
  before any conversation; unreadable subject refused; no runner (headless) = waits, logged once;
  orphaned `dispatched` agent task settled `interrupted` at coordinator start (in-flight map is
  process-wide). GEX44 @2e0546d8d: tsc 0, 6 gates rc=0, 610 passed/71 files. Mutations 6 CAUGHT +
  1 EQUIVALENT removed (runner already awaits durable writes; a test comment saying otherwise is stale).
  Lesson: with a runner registered, the dispatch LOCK masked a missing terminal-pool filter — only the
  no-runner world could see it.
- Coherence anchor for P2: `git log --format=%s -1 aef4c0066` = "test(federation): pin the terminal-pool filter...".

## 3. Active decisions
- Delegation = orchestration task with assignee Agent + requester Agent + subject (project,
  worktree, revision captured from git by Orca). Result = structured `tasks.result`, NOT a
  terminal `worker_done` message (agents have no handle). Requester-agent notification in its own
  conversation is NOT built yet — the parent reads the child row.
- Depth/fan-out bound enforced in `createTask`, not prompts.
- Providers behind existing `ConversationTurnDriver`; availability states fail closed on unknown.
- Review record in orchestration db; independence DERIVED; stale when revision moves.
- Decision gates gain subject binding; AEOS W7 projection consumes it.
- Schema v30 collision risk with AEOS W5 — whoever lands second rebases.
- Heavy verification on GEX44 (bundle + revision fence, memory `gex44-is-the-linux-evidence-node`).

## 4. Next 3 actions
1. P2c: expose delegation on the existing surfaces — `orchestration.taskCreate` RPC + CLI accept
   `--assignee-agent`/`--requester-agent`/subject, with the SUBJECT REVISION captured by Orca from git
   (never from the caller's text); DelegationRefusedError maps to a named RPC error code.
2. P3: provider driver registry + availability states (AUTH_REQUIRED/QUOTA_EXHAUSTED/UNSUPPORTED/
   UNKNOWN) + Claude driver behind ConversationTurnDriver + deterministic routing with a reason.
3. P4: review record bound to subject revision, independence derived, stale on revision move.
Then P5 subject-bound approval (inverts P1's gate case), P6 surface, P7 gate + UKDL, P8 GEX44 local
runtime (Owner approved install; RTX 4000 Ada 20 GB, nothing installed).

## 5. Start
`Set-Location C:\Users\User\Apps\orca-federation-wt`; prove `git worktree list`; read this file and
the plan in the session transcript; tests via `node node_modules/vitest/vitest.mjs run --config
config/vitest.config.ts <paths>` — never the full suite locally.
