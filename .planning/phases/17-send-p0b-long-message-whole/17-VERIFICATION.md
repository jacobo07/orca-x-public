---
phase: 17
status: passed
verified: 2026-10-27
residual: device leg OWNER_BOUND (a new APK from this branch on the S25 Ultra, then a long multi-paragraph message to a live Claude tab)
---

# Phase 17 verification: a long multi-paragraph phone message arrives whole

## Finding

The beginning is lost between the Orca host's write of a TYPED body and Claude Code's input line, not in Claude Code
alone. A synthetic 6-paragraph, 1159-char body (blank lines between paragraphs, one emoji) with a head and a tail
marker:

| Plane | Shape | Body chars | Whole (head + tail in one request) |
|---|---|---|---|
| Direct: real claude.exe under ConPTY, no Orca (evidence/17-multiparagraph-harness.cjs) | shipped phone shape (`\x15`, raw body, `\r` 500 ms) | 785 (LF), 791 (CRLF), 1159 | yes, yes, yes |
| Orca serve host on this laptop, SCRIPTED CLIENT, out/ of 14:17 (src/main/runtime/mobile-agent-send-multiparagraph.live.test.ts) | shipped phone shape | 785 | yes |
| same | shipped phone shape | 1159 | **no**: tail only; the input line read `❯ out the drive and…` (cut mid-word, as on the device) |
| same | `\x15`, ONE bracketed paste, 1500 ms, `\r` as its own write | 1159 | yes |

Traces: evidence/p17-*.json (direct), evidence/p17-live-orca-host-traces.ndjson (host). The exact layer inside the
host path that drops the head was not isolated; the paste shape removes the dependency on it, and it is the shape the
desktop already uses for agent prompts (`sendTerminalAgentPrompt`).

## Fix (253e1799a)

- `mobile/src/session/mobile-native-chat-send.ts`: `asAgentPrompt` sends the body as `buildAgentPromptPasteBytes(text)`
  (no Enter), waits `MOBILE_NATIVE_CHAT_PASTE_SETTLE_MS` (1500, the desktop's Windows settle; the phone cannot see the
  host OS), then sends `\r` as its own write. The launch-draft resolution rides only on the submit. A refused paste is
  `rejected` and sends no Enter; a failed Enter after an accepted paste is `unknown`, never `rejected`, because the body
  already sits on the input line and a retry would paste it twice.
- `use-mobile-native-chat-message-send.ts`: only composer chat turns (`syncComposer && classification === 'chat'`).
  Question answers and slash commands stay typed keys.
- `src/shared/agent-prompt-paste-bytes.ts`: the paste builders moved out of `agent-prompt-injection.ts` (which reads
  `process.platform` at load) so the phone can import them; `agent-prompt-injection.ts` re-exports them unchanged.

## Older hosts

No wire or host change. Every shipped host writes `terminal.send` text verbatim (`sendTerminal` → `writeTerminalAction`),
which is how the live leg above delivered the paste through the unchanged host. `agentPrompt: true` was NOT used: the
host grants it only to `client.type === 'desktop'` and an older host would strip it.

## Tests and gates

- Unit, at the owner: `mobile-native-chat-send-admission.test.ts` +4 (paste then Enter as ONE paste, draft only on submit,
  refused paste sends no Enter, failed Enter is unknown). Mutant (paste branch disabled): 3 FAIL = CAUGHT, restored green.
- Hook: `use-mobile-native-chat-message-send.test.ts` +2. Mutant (`asAgentPrompt: false` at the caller): CAUGHT on GEX44,
  RESTORE_VERIFIED.
- GEX44 /tmp/orca-phone-p17-20261027183915: mobile `src/session` 149/149 files pass; hook file 28/28.
- mobile tsc: 3 errors, the same 3 pre-existing (generated webview engines, mobile-workspace-client.ts:142); 0 new.
- Desktop `tsc -p config/tsconfig.node.json`: exit 0 on the laptop.
- Pre-existing, unrelated: `src/main/runtime/rpc/terminal-agent-prompt-send.test.ts` fails 2/2 with HEAD's own
  `agent-prompt-injection.ts` too (measured by swapping the file back).
