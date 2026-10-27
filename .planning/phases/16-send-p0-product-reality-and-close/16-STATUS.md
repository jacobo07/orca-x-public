---
phase: 16
status: in_progress
updated: 2026-10-27
---

# Phase 16 status

| Criterion | State | Evidence or the missing step |
|---|---|---|
| 1. Real phone + real Windows host legs | OWNER_BOUND (APK STAGED) | APK BUILT 2026-10-27 17:09 on GEX44 from 854f34c01 (recipe /tmp/orca-phone-p12-20261027112155/build-send.sh: expo prebuild + assembleRelease arm64-v8a, template debug key as before): `C:\Users\Jacobo\Downloads\orca-x-send-p0-854f34c01.apk`, 59,352,692 bytes, sha256 cc738f6be32a5b2393b9883c5c4945355a56633a6c80615fae6e120afefc262c (verified after copy). Native-module gate 41/0 exit 0; the Hermes bundle carries both delivery captions (UTF-16 probe, 1 hit each). The fix is still not on the phone. Missing: installed by the Owner on the S25 Ultra (lock screen), then a live Claude tab. Legs owed: a >=94-char prompt with a nonce becomes a desktop turn, and the bubble goes written → gone (the transcript turn) with no duplicate; terminal command fresh output; send+scroll anchored; send+lease. |
| 2. 13 mutants | 12 of 13 PLANTED+CAUGHT | 16-MUTANTS.md: 11 CAUGHT, 1 first SURVIVED → test → CAUGHT. #12 was NOT planted this phase (host lease code; its cover is the phase 12 tests), so the roadmap wording "all 13 report PLANT_CONFIRMED" is not literally met. Rows 4, 5 and 11 reuse earlier-phase mutants. Plant and restore are recorded only in the 16-MUTANTS.md header, not per row. |
| 3a. Knowledge Vault incident | DONE | `~/.claude/knowledge_vault/lessons/mobile-chat-send-written-is-not-admitted.md` |
| 3b. UKDL entries | CANDIDATES ONLY | HR/PR/TRAP drafted in the KV note. Promotion waits for the device leg (the brief: "promoted only with evidence") |
| 3c. Ratchet gate | DONE | `pnpm check:mobile-remote-effect-bubbles` (config/scripts/check-mobile-remote-effect-bubbles.mjs, in `lint` and pr.yml). Population by what code does: files under mobile/app + mobile/src that mint a stand-in row id (`pending-/local-/optimistic-/echo-/temp-/tmp-${...}`), floor 5 sites (7 today in 2 files). Each must reach `mobile-native-chat-delivery-evidence.ts` (direct or one relative hop) or sit in `config/mobile-remote-effect-receipt-baseline.txt` (only tasks.tsx: GitHub/Linear comment rows built after the provider create succeeded). Baseline shrink-only; stale lines fail. 11 unit tests; real-tree mutants M1 planted rogue `optimistic-${n}` file CAUGHT, M2 baseline line removed CAUGHT, both RESTORE_VERIFIED; check:ci-gate-coverage 38/39 invoked. Limit: a surface that renders an optimistic row WITHOUT minting a prefixed id is outside the sweep. |
| 3d. Fresh-agent test | PASS (2026-10-27, worker epoch 3) | A read-only agent with no context, starting from RESUMPTION_FILE.md + STATE.md at e948f7db8, answered 7 of 7 questions with file:line citations (trigger, root cause and the >=94 threshold, fix 4e00f6e22 and why not the host path, bubble states and 20 s, the ratchet command and baseline, what remains and who owns it, push is Owner-only). It found 13 gaps; the doc drift was fixed in the same commit (see STATE.md Decisions 2026-10-27 epoch 3). |
| 3e. Two-layer handoff | DONE in STATE.md Current Position | |
