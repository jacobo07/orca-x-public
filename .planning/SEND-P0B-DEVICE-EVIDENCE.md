# SEND-P0b: first device leg on the fixed APK (2026-10-27 ~18:15)

Phone: the Owner's S25 Ultra, with APK `cc738f6b…262c` (built from 854f34c01) installed at 17:52. Hash verified on the device over adb.
Host: **Host 1 = the Owner's OTHER Windows PC** (`C:/Users/User/Desktop/Cursor Projects/Jacobo`), not this laptop.
Tab: Claude Code "Casual greeting about the drive". Evidence comes from phone screenshots (adb) and the Owner pasting the Host 1 terminal text.
The Owner's message text is personal and is NOT reproduced here.

## Observed
1. **Submit fixed (CONFIRMED on device).** `hola?` (short) became a real turn on Host 1, and Claude answered it.
   The long message was also submitted as a turn.
2. **NEW DEFECT: a long multi-paragraph body loses its BEGINNING.**
   - The message: roughly 600-900 chars, 4 paragraphs separated by blank lines, one emoji (😂).
   - Claude on Host 1 received only the tail. The cut is mid-word ("…fianza de su comunidad." from "confianza").
   - On repeated sends the cut starts later each time. Claude itself said: "the paste is cut at the beginning".
   - So this is byte-length truncation, not line-based.
   - Lead: the phone sends a chat body as raw typed text (`terminal.send` text + enter; host `writeTerminalInputChunks`).
     The desktop sends long prompts as ONE bracketed paste with a settled submit (`agentPrompt: true` →
     `sendTerminalAgentPrompt` / `buildAgentPromptPasteBytes`). Phase 13 measured that shape admitted at 334 chars.
   - `rpc/methods/terminal.ts` grants `useSettledAgentPrompt` only to `client.type === 'desktop'`.
   - Suspects: ConPTY / Claude Code input buffer limits for typed, non-paste input; chunk boundaries;
     the newlines inside the body.
3. **FALSE "Agent has not shown this message"** on `hola?`, which WAS shown as a turn.
   - The long message also shows it. That one is arguably right, because its text never matched in full.
   - The transcript-echo matcher in `mobile-native-chat-delivery-evidence` / pending-echo misses a real turn.
   - Suspects: the chat transcript stream on the phone was not refreshed; normalisation of `?`; or a
     baseline/occurrence mismatch.
4. The terminal search on the phone for "hola" returned 0/0. There was no positive control, so this is INCONCLUSIVE.

## Constraints
- Host 1 runs its own installed Orca X version (unknown). Any host-side change (e.g. admitting mobile
  `agentPrompt`) needs a capability check and a fallback for an older host, per docs/reference/remote-wire-compatibility.md.
- Reproduce both defects with the phase-13 harness (real claude.exe under ConPTY + a fake API) using a
  SYNTHETIC multi-paragraph body of the same shape. Never use the Owner's text.
