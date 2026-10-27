# RESUMPTION: Orca X phone control, SEND-P0 (mobile chat send)

The previous content (the cognitive-workspace program in another worktree) is in git at 7bf794481.

## 1. Identity
Worktree `C:\owx-pc`, branch `mobile/phone-control`, mission m-aae9a9c1405c. GSD state is in
`.planning/STATE.md` and `.planning/ROADMAP.md` (both tracked). The brief and laws are in `.planning/SEND-P0-PLAN.md`.
Thesis: a phone chat message is delivered only when the agent's transcript shows the turn. A PTY write
receipt is not delivery.

## 2. Exact state (2026-10-27 ~17:30)
Phases 13, 14 and 15 are sealed (`.planning/phases/13-*`, `14-*`, `15-*`, each with a VERIFICATION.md).
- Root cause: Ctrl+U bundled with a paste-sized body (>=94 chars) left Claude Code unsubmitted.
- Fix 4e00f6e22: the clear goes out as its own write. Evidence bubble a07d1d195: 'written', then
  'unconfirmed' after 20 s. Refusal reasons 3e454579f.
- Coherence anchor: `git log --oneline -1` shows 87f24ac79 or later. GEX44 mobile `src/session` 149/149.
Phase 16 is open. Phases 5, 7 and 9 are deferred-human (do not rework them).

## 3. Active decisions
- Fix shape (a), the phone-side split, not the host agent-prompt path. There is no wire change.
- There is no Retry on an unconfirmed bubble, so no duplicate turns.
- Never push: STATE.md laws make pushing Owner-only. Heavy tests run on GEX44 in `/tmp/orca-phone-p*`, torn down afterwards.

## 4. Next three actions
1. Phase 16, deterministic part: the remaining SEND-P0 mutants (send skips the RPC, wrong host or session id,
   lease-lost mapped to success, duplicate after reconnect, echo shown twice, agent send requires the lease,
   capability mismatch treated as success). Then a `check:*` ratchet so every mobile remote-effect bubble takes
   its state from `mobile-native-chat-delivery-evidence.ts`.
2. KV incident "written != admitted" and the UKDL candidates (SEND-P0-PLAN.md, Institutional close).
3. Device legs: OWNER_BOUND. Build an APK from this branch, the Owner installs it, then run the real phone
   Agent send and terminal send.

## 5. Start
Run `git status --short; git log --oneline -5`, read `.planning/STATE.md` Current Position, then do action 1.
