---
phase: 20
status: passed
date: 2026-10-27
---
# Phase 20: a blind phone chat does not blame the agent

## Why
This is the residual from phase 19. While the phone chat had no session id (`waiting-session`), it subscribed to no transcript, so it could not see any echo. After 20 s the bubble still said "Agent has not shown this message", although Claude had shown it (device leg 2). That wording invites a duplicate resend.

## Change (phone only; no wire, host or state change)
- `mobile/src/session/mobile-native-chat-delivery-evidence.ts`: `mobileNativeChatDeliveryCaption(delivery, transcriptReadable = true)`.
  - An `unconfirmed` bubble with no readable transcript reads "This phone can't read the agent's chat yet · check the desktop before resending".
  - `written` is unchanged.
- Row rendering moved from `MobileNativeChatView.tsx` into `use-mobile-native-chat-row-renderer.tsx`, because the new prop pushed the view past `max-lines` 400 (which AGENTS.md forbids disabling).
  - The hook passes `transcriptReadable = status === 'ready'` to each row, and `MobileNativeChatMessage.tsx` forwards it to the caption.
  - The verification below re-ran on the split code; M1 is planted in the hook.
- Nothing is marked delivered. The bubble stays unconfirmed; only the claim about who failed changes.

## Evidence (GEX44, disposable root /tmp/orca-phone-p20-20261027195827, torn down)
The first run was void: `Compress-Archive` flattened the paths, so the original files ran. It was caught because neither mutant was planted (count 0) and the suite total did not grow. The rerun used a path-preserving tar, and `git diff --stat` showed the 5 changed files as a positive control.
- **New and existing tests:** delivery-evidence + MobileNativeChatView, 19/19 passed.
- **M1** (view always readable): PLANT_CONFIRMED, CAUGHT ("tells a pending bubble when the chat has no transcript feed").
- **M2** (caption ignores the flag): PLANT_CONFIRMED, CAUGHT ("does not blame the agent…").
- **Restore:** RESTORE_VERIFIED (cmp).
- **mobile src/session:** 149 files, 1293 tests passed (1291 before + 2 new).
- **mobile tsc:** the 3 pre-existing errors (MermaidDiagram, terminal-webview-html, mobile-workspace-client), 0 new.

## Owed
It reaches the Owner's phone only with a new APK built from this branch, which is OWNER_BOUND, like phase 16.
