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

## Second device leg (2026-10-27 19:19, APK 97b783068 sha256 93782b3e… installed 18:51, verified on the device)
Driven over adb by the arming session (Owner-authorized, NEW Claude tab on Host 1, synthetic text):
- The phone typed a 744-char, 4-paragraph body (blank lines between paragraphs) starting `ORCA-NONCE-7` and ending `FIN-7`, then pressed Send.
- **Phase 17 PROVEN ON DEVICE.** The Owner pasted the Host 1 terminal: the whole body sits as one `❯` prompt, and Claude replied
  "Primera palabra: ORCA-NONCE-7 / Última palabra: FIN-7 / Párrafos: 4". Claude Code auto-titled the tab "Prueba sintética de Orca X".
- **Still broken: the phone never shows the turn.** For about 2 minutes, the phone chat showed only the optimistic bubble with
  "Agent has not shown this message · check the desktop before resending". It showed no assistant reply and no canonical user turn,
  even though the tab title did update on the phone. So the false warning is NOT (only) the matcher. The phone's chat
  transcript feed for this Host 1 session delivers no turns. In the older "Casual greeting" tab, assistant replies DID reach the
  phone earlier. Compare the two: a new session vs an existing one, transcript discovery for a tab created from the phone,
  the host path `C:/Users/User/...` vs the account home, and the Host 1 Orca version.

## Third device leg: phase 19 on Host 2 (2026-10-27 21:14, same APK 97b783068, driven over adb, Owner-authorized)
Host 2 = this laptop (192.168.7.11, installed Orca X c4679d615). Workspace "Cursor Projects Provisional", phone New tab > Claude.
- The new claude.exe (PID 9760, started 21:14:56 by the phone's tab) carries the full hook env: ORCA_AGENT_HOOK_PORT/TOKEN/ENV/
  VERSION/ENDPOINT, ORCA_PANE_KEY, ORCA_TAB_ID, ORCA_AGENT_LAUNCH_TOKEN. This was read from the process environment block,
  names and lengths only. `~/.claude/settings.json` has the Orca Claude hook (`cmd.exe /d /c %USERPROFILE%\.orca\agent-hooks\claude-hook.cmd`).
- Sent `ORCA-NONCE-19 responde solo OK-19` at 21:16:23. The transcript `~/.claude/projects/C--Users-Jacobo-Desktop-Cursor-Projects-Provisional/9dc15e94-….jsonl`
  holds the nonce and the reply. **The phone showed the user turn as delivered (no warning) and Claude's reply `OK-19`**, and the
  tab title updated to "Respuesta OK-19 de ORCA-NONCE-19".
- **Verdict: phase 19 does NOT reproduce on a c4679d615 host whose Claude hooks are installed.** The failure is specific to Host 1
  (`C:\Users\User`). Ranked suspects on Host 1: (1) its `C:\Users\User\.claude\settings.json` lacks the Orca Claude hook
  (Owner's PP config differs there, or Orca's hook install never ran / was overwritten), so no providerSession is ever posted;
  (2) Host 1 is not actually on c4679d615; (3) a different account home. Each one is checkable on Host 1 only (OWNER_BOUND or ssh).
- Test leftovers on this laptop: one Claude tab in "Cursor Projects Provisional" (session 9dc15e94) is still open.

## Constraints
- Host 1 runs its own installed Orca X version (unknown). Any host-side change (e.g. admitting mobile
  `agentPrompt`) needs a capability check and a fallback for an older host, per docs/reference/remote-wire-compatibility.md.
- Reproduce both defects with the phase-13 harness (real claude.exe under ConPTY + a fake API) using a
  SYNTHETIC multi-paragraph body of the same shape. Never use the Owner's text.
