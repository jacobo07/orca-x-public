# RESUMPTION: Orca X phone control, SEND-P0 (mobile chat send)

The previous content (the cognitive-workspace program in another worktree) is in git at 7bf794481.

## 1. Identity
Worktree `C:\owx-pc`, branch `mobile/phone-control`, mission m-aae9a9c1405c. GSD state is in
`.planning/STATE.md` and `.planning/ROADMAP.md` (both tracked). The brief and laws are in `.planning/SEND-P0-PLAN.md`.
Thesis: a phone chat message is delivered only when the agent's transcript shows the turn. A PTY write
receipt is not delivery.

## 2. Exact state (2026-10-27 ~19:00, worker epoch 3)
Phases 13, 14 and 15 are sealed (`.planning/phases/13-*`, `14-*`, `15-*`, each with a VERIFICATION.md).
- Root cause: Ctrl+U bundled with a paste-sized body (>=94 chars) left Claude Code unsubmitted.
- Fix 4e00f6e22: the clear goes out as its own write. Evidence bubble a07d1d195: 'written', then
  'unconfirmed' after 20 s. Refusal reasons 3e454579f.
Phase 16 status table: `.planning/phases/16-send-p0-product-reality-and-close/16-STATUS.md`.
- Done: 13 mutants (16-MUTANTS.md), KV lesson, ratchet gate `pnpm check:mobile-remote-effect-bubbles` (49038b8db).
- Coherence anchor: `git log --oneline -1` shows 49038b8db or later.
- Fresh-agent test (3d) PASS 7/7. Push state: origin/mobile/phone-control = c4679d615; SEND-P0 commits are local only.
- OWNER_BOUND: device legs (criterion 1). UKDL stays candidates-only until then.
Phases 5, 7 and 9 are deferred-human (do not rework them).

## 3. Active decisions
- Fix shape (a), the phone-side split, not the host agent-prompt path. There is no wire change.
- There is no Retry on an unconfirmed bubble, so no duplicate turns.
- GitHub/Linear comment rows in tasks.tsx are receipt-backed (built after the provider create succeeded), so they
  sit in `config/mobile-remote-effect-receipt-baseline.txt`, not on the chat presenter.
- Never push: STATE.md laws make pushing Owner-only. Heavy tests run on GEX44 in `/tmp/orca-phone-p*`, torn down afterwards.

## 4. Next three actions
1. (Done: fresh-agent test PASS.) Nothing deterministic remains in phase 16; do not invent work.
2. Device legs, OWNER_BOUND: the APK is BUILT and staged at `C:\Users\Jacobo\Downloads\orca-x-send-p0-854f34c01.apk`
   (sha256 cc738f6b…262c, 16-STATUS row 1). The Owner moves it to the S25 Ultra and installs it, then run the >=94-char Agent send with a nonce, terminal send fresh output, send+scroll, send+lease.
3. After the device leg passes: promote the UKDL candidates from the KV note and close phase 16 (VERIFICATION.md).

## 5. Start
Run `git status --short; git log --oneline -5`, read `.planning/STATE.md` Current Position, then do the first
action that is not done.
