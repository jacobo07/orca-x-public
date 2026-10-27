---
phase: 16
status: in_progress
updated: 2026-10-27
---

# Phase 16 status

| Criterion | State | Evidence or the missing step |
|---|---|---|
| 1. Real phone + real Windows host legs | OWNER_BOUND | The fix is not on the phone yet. Missing: an APK built from this branch (>= 9a8c6414d), installed by the Owner on the S25 Ultra (lock screen), then a live Claude tab. Legs owed: a >=94-char prompt with a nonce becomes a desktop turn, and the bubble goes written → gone (the transcript turn) with no duplicate; terminal command fresh output; send+scroll anchored; send+lease. |
| 2. 13 mutants | DONE | 16-MUTANTS.md: 11 CAUGHT, 1 not planted (host lease code, phase 12 tests), 1 first SURVIVED → test → CAUGHT |
| 3a. Knowledge Vault incident | DONE | `~/.claude/knowledge_vault/lessons/mobile-chat-send-written-is-not-admitted.md` |
| 3b. UKDL entries | CANDIDATES ONLY | HR/PR/TRAP drafted in the KV note. Promotion waits for the device leg (the brief: "promoted only with evidence") |
| 3c. Ratchet gate | DONE | `pnpm check:mobile-remote-effect-bubbles` (config/scripts/check-mobile-remote-effect-bubbles.mjs, in `lint` and pr.yml). Population by what code does: files under mobile/app + mobile/src that mint a stand-in row id (`pending-/local-/optimistic-/echo-/temp-/tmp-${...}`), floor 5 sites (7 today in 2 files). Each must reach `mobile-native-chat-delivery-evidence.ts` (direct or one relative hop) or sit in `config/mobile-remote-effect-receipt-baseline.txt` (only tasks.tsx: GitHub/Linear comment rows built after the provider create succeeded). Baseline shrink-only; stale lines fail. 11 unit tests; real-tree mutants M1 planted rogue `optimistic-${n}` file CAUGHT, M2 baseline line removed CAUGHT, both RESTORE_VERIFIED; check:ci-gate-coverage 38/39 invoked. Limit: a surface that renders an optimistic row WITHOUT minting a prefixed id is outside the sweep. |
| 3d. Fresh-agent test | OPEN | Run after 3c: a read-only agent answers from durable state (RESUMPTION_FILE.md, STATE.md, 13-16 verification) |
| 3e. Two-layer handoff | DONE in STATE.md Current Position | |
