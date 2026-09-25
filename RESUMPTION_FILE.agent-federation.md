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

- **P2c SEALED** `fcbcb1033`: `orchestration.taskCreate` + `orca orchestration task-create
  --assignee-agent <id>`. The requester is DELIBERATELY not a parameter (any worker terminal can
  call this RPC; a requester field is an identity spoof). GEX44: tsc node+cli 0, 135/135, mutation
  `requester-passthrough` CAUGHT. Subject is not on the RPC yet — it arrives with P4, captured by Orca.

- **P2d SEALED** `54d8e0289`: every agent task's turn is offered `orca_delegate(agent, task)`
  (`agent-delegate-tool.ts`). Codex declares it as a `dynamicTools` entry on `thread/start` and calls
  back with `item/tool/call`; `codex-server-request-bridge.ts` answers only a DECLARED tool name.
  Parent/requester/subject/run are bound in the closure from the task being worked — argument
  claims are ignored (pinned). GEX44: tsc 0, 4 gates rc=0, 1727 passed/176 files, 6/6 mutations CAUGHT.
  MEASURED: `thread/resume` has no `dynamicTools` (codex 0.153.4) — tools may not survive a resume.
  UNMEASURED: a live provider calling the tool (no signed-in Codex; GEX44 quota until 2026-09-27).

- **P2e SEALED** `47d240c17`: a delegating agent's task waits (`dispatched` + result
  `awaitingChildren`, no new status — the status CHECK constraint is not alterable in SQLite), and
  once every child it delegated settles it gets a follow-up turn in the SAME conversation with the
  children's results (excerpts ≤4000 chars). Rounds ≤ 4 (`agent-rounds-exceeded`). Slots count only
  running work — counting all dispatched rows let waiting parents starve their children (pinned at
  maxConcurrent 1). Follow-up may continue only the agent's own conversation. GEX44: tsc 0,
  1714 passed/176 files, 5/5 mutations CAUGHT on a GREEN baseline (a first run was on a red one — a
  test pinning the exact result object; re-measured, not waved through).
- **P2 (agent delegation) is complete at the unit/integration rung.** Not yet product-real: no live
  provider has run a delegation, and no UI shows it.

- **P3 measured, not built (2026-09-24).** One live `claude -p --output-format stream-json` probe
  (Claude Code 2.1.281; memory `claude-cli-stream-json-protocol-and-quota`): events system/init →
  assistant → rate_limit_event → result. `rate_limit_event` carries real quota state. Scope with
  `--setting-sources project` (NOT `--bare`, which drops OAuth). That one-word turn cost **$0.93**.
  The Owner's **7-day Claude quota was at 99%** (reset ~2026-09-27 18:00 UTC) — the same quota Claude
  Code runs on — the Owner then said "continue, it's good now" (2026-09-24) and live runs resumed.
- **P3 SEALED** `ee091362b`..`dbf35a3ca`. Two pre-existing bugs found and fixed, each RED-first +
  mutation-caught: (1) provenance hardcoded `codex` and resume ignored provider — a second driver
  would have resumed another provider's session (driver now declares a REQUIRED `provider`);
  (2) the runner returned `completed` for a provider-FAILED turn (`turn-ended`) — now `failed` with
  the provider's reason. Built: `claude-conversation-driver.ts` (+ `claude-stream-mapping.ts`,
  fixture = the real capture), `claude-auth-readiness.ts`, `provider-quota-observations.ts`,
  `conversation-provider-routing.ts` (deterministic, every skip has a reason; preferred >
  continuity > tools > registry order; exclude), `routed-conversation-turn.ts`, new outcome
  `no-provider` (refused before commit; renderer notice + en.json key), and
  `provider-routing-composition.ts` = the ONE composition both IPC and delegated tasks use.
  GEX44 @dbf35a3ca: tsc node 0 / cli 0 / tc.web 2 (inherited from AEOS `f9a721fda`, untouched),
  ~2000 passed. Mutations: 4 routing + 2 fixes, all CAUGHT.
  **LIVE-OBSERVED (opt-in `ORCA_CLAUDE_REALITY=1`):** Claude driver resume across 2 real turns
  (random word recalled); a person-assigned agent task run by the REAL coordinator through
  production routing on the real provider (Claude — Codex signed out here), settled with a
  structured result. Localization catalog/coverage gates are red on pre-existing cogws keys, not ours.

- **P4a SEALED** `4aa2cf116` (schema **v31**): `review-records.ts` — `reviews` table, derived
  independence (same agent / same provider degraded, missing provider `unknown`), `judgeReviewCurrency`
  (revision-moved / patch-changed / subject-unreadable), `ReviewStore.settle` re-derives independence
  from the provider that ACTUALLY reviewed. GEX44: tsc 0, migration gate ok, 1342 passed, mutation CAUGHT.

- **P4b SEALED** `5c51b36ee`..`da3ec43c0` (schema **v32**: reviews.policy, reviews.producer_task_id).
  Fix: an unnamed builder is `unknown`, not independent. `review-subject-capture.ts` (diff-tree plumbing,
  every config knob pinned, merge refused), `review-findings.ts` (`orca.review-findings/1`: structured /
  unstructured / failed), task results record the provider that RAN them (`provider`), `requestReview`
  (producer read from a completed task's result; `independent` refused when unkeepable; task+row in one
  txn), coordinator: review tasks get no tools + exclude producer provider; `settleReviewForTask` on
  every settlement path; RPC/CLI `review-request` / `review-show` (currency from git at read time).
  GEX44 @550edc56e: tsc 0, migration gate 0, 2898 passed/324 files, 9/9 mutations CAUGHT, restores
  SHA-verified. LIVE (commit 2e8c5516a, Claude only): independent review -> `failed/no-provider`; any ->
  `degraded-same-provider`, structured approve + 2 minor; new commit -> `revision-moved`.
  Deviation from the plan above: reviewer provider comes from the routed result, not conversation
  provenance (stronger: the driver that actually ran). UNPROVEN: independent review across two live providers.
- Schema order now: main v28, AEOS v29 (merged), federation v30-v33. If AEOS lands a v30 first, renumber
  v30-v33 here in ONE dedicated commit before merging.

## 4. Next 3 actions
1. P5 (in progress, uncommitted: db.ts v33 gate columns, types.ts, skew, `subject-bound-gates.ts`):
   db methods createGate(+subject/reviewRequirement), decideSubjectGate, staleSubjectGate, rebind;
   effect checks `authorizeGatedEffect` in startTurn (agent) and before createDispatchContext
   (terminal, new `approval-refused`); RPC gateResolve REFUSES subject-bound gates (a terminal agent
   can call RPC, so RPC cannot prove a person) — they are decided through desktop IPC (P6 UI).
   Rejection must not unblock (today resolveGate sets `ready` for ANY text).
2. Claude MCP bridge so `orca_delegate` works when Claude is the provider.
3. P6 surface: first merge `orca-x/cogws-product-surface@33b8d089a` (that pane waits on us).
Then P7 gate + UKDL, P8 GEX44 local runtime (Owner approved install; RTX 4000 Ada 20 GB).
Local host is starved (~0.9-4 GB free): run tests on GEX44 (`/home/kobii/fed-wt`, push
`HEAD:refs/federation/head`, assert REV); local only for the opt-in live Claude tests.

## 5. Start
`Set-Location C:\Users\User\Apps\orca-federation-wt`; prove `git worktree list`; read this file and
the plan in the session transcript; tests via `node node_modules/vitest/vitest.mjs run --config
config/vitest.config.ts <paths>` — never the full suite locally.
