# Phase 13: SEND-P0 nonce trace and RED - Context

**Gathered:** 2026-10-27
**Status:** Ready for planning
**Mode:** Smart discuss, autonomous. The Owner was away. Grey areas were resolved from the Owner-approved brief (.planning/SEND-P0-PLAN.md, "go" 2026-10-27) and the Owner evidence (.planning/SEND-P0-OWNER-EVIDENCE.md).

<domain>
## Phase Boundary

Name, by evidence, the first stage where a mobile Agent message stops being real, and leave a RED that fails on that regression at its owner. No product fix in this phase (phase 14).

</domain>

<decisions>
## Implementation Decisions

### Trace plane
- The installed Orca X cannot be paired without the Owner's "Copy pairing code" click: no RPC mints a pairing offer (`pairing.ts` only has getEndpoints/provisionRelay), and only `--serve` mode or the UI creates one. So the nonce trace runs on a disposable Windows serve host built from the same worktree out/. It uses a disposable profile and home, loopback only, a SCRIPTED CLIENT, and is torn down at the end. This is the phase 9 recipe. The installed-app plane is covered by the Owner's own observation (screenshots).
- The provider is the real `claude.exe` 2.1.311 TUI. Its `ANTHROPIC_BASE_URL` points at a local fake API, so "the agent turn exists" is observed as a provider request carrying the nonce. No quota is spent, and the Owner's real home and config are not used (CLAUDE_CONFIG_DIR is disposable).

### Isolation of the cause
- A direct harness (node-pty ConPTY + headless xterm, no Orca) varies one factor at a time: byte shape, length, emoji, and submit delay. The through-host trace then confirms the decisive pair.
- Every negative has a positive control in the same run (the desktop bracketed-paste shape, and the split-clear shape).

### RED
- Deterministic RED at the owner (`mobile-native-chat-send.ts`): the write that carries a chat body must not carry the clear byte, and the clear goes out alone first. This is the shape measured to be admitted.
- Live RED (`src/main/runtime/mobile-agent-send-admission.live.test.ts`, skipped without its ORCA_LIVE_* env). Its contract is "the agent turn exists" (provider request with the nonce), with the split shape as the in-run control.

### Privacy
- The Owner's real message is personal. Committed tests and evidence use a synthetic message of the same shape (Spanish, two emoji, ~140 chars), which was measured to reproduce identically. Raw runs that contain the real text stay out of the repo.

### Claude's Discretion
- Harness mechanics, wait bounds and evidence layout.

</decisions>

<code_context>
## Existing Code Insights

- Mobile chat send: `mobile/src/session/use-mobile-native-chat-message-send.ts` -> `mobile-native-chat-send.ts` `sendMobileNativeChatMessageWithOutcome` (clearInputFirst prefixes `\x15` onto the body write).
- Host: `terminal.send` (`src/main/runtime/rpc/methods/terminal.ts`) -> `OrcaRuntimeService.sendTerminal` -> `writeTerminalAction`: text chunks, a fixed 500 ms wait, then `\r`. The settled agent-prompt path (bracketed paste + render gate, 1500 ms on Windows) exists, but only for `client.type === 'desktop'` with `agentPrompt: true`.
- Live-leg kit: `mobile-protocol-test-client.ts`, `mobile-live-leg-steps.ts`.

</code_context>

<specifics>
## Specific Ideas

The Owner evidence names the incident: a Claude Code tab on Host 1, with the phone's message left unsubmitted on the `>` line after shorter messages had worked.

</specifics>

<deferred>
## Deferred Ideas

- The fix and the delivery-evidence bubble states: phase 14.
- A scripted trace against the Owner's installed app (needs the pairing click): optional confirmation, not required to name the stage.
- Codex is not installed on this laptop, so the Codex TUI was not measured.

</deferred>
