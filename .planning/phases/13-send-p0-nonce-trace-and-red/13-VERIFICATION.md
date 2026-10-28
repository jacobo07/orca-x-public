---
phase: 13
status: passed
verified: 2026-10-27
residual: the scripted trace was not run against the Owner's installed app (OWNER_BOUND, needs the Mobile "Copy pairing code" click); that plane is covered by the Owner's screenshots
---

# Phase 13 verification: SEND-P0 nonce trace and RED

## Finding

**First missing receipt: between the PTY write and turn admission.** The phone's native-chat send writes
`\x15` (Ctrl+U) and the message body in ONE `terminal.send`, and the host writes `\r` 500 ms later. When the body is
paste-sized, Claude Code (2.1.311, Windows ConPTY) takes the burst as a paste, and the later Enter is not
taken as submit. The message stays on the desktop `>` input line. The host still answers
`{accepted: true, bytesWritten: 167}`, and the phone renders a normal sent bubble from that write receipt (`acceptSend`).
Short messages work, which is why earlier phone messages in the Owner's session went through.

The bundled prefix was introduced in b41e813cb (2026-07-28, "surface draft launch context").

## Evidence by plane

### 1. Owner, installed app, physical phone (OWNER-OBSERVED, .planning/SEND-P0-OWNER-EVIDENCE.md)
A Claude Code tab on Host 1. The phone's ~140-char message with two emoji sat unsubmitted on the `>` line, with no turn after it.
The phone held the floor. The phone showed a normal sent bubble.

### 2. Direct harness: real claude.exe under ConPTY, no Orca (evidence/direct-*.json, evidence/13-direct-tui-harness.cjs)
Admission = a provider request at the fake API carrying the nonce.

| Shape | Body chars | Admitted |
|---|---|---|
| desktop bracketed paste, 1500 ms (positive control) | 34, 334 | yes, yes |
| phone: `\x15`+body, `\r` at 500 ms | 34, 54 | yes, yes |
| phone: `\x15`+body, `\r` at 500 ms | 94, 134, 184, 254, 334 (x3) | no, every time |
| phone shape with the Owner's exact text (not committed, privacy) | 159 | no |
| phone shape with a synthetic text of the same shape | 152 | no |
| phone shape, `\r` at 3000 ms | 334 | no (not timing) |
| body without `\x15`, `\r` at 500 ms | 334 | yes |
| `\x15` as its own write, then body, `\r` at 500 ms | 334, 152 synthetic, Owner's text | yes, yes, yes |
| same split on a dirty input line | 334 | yes, line cleared |
| short body with two emoji | 32 | yes (not emoji) |

### 3. Through a real Orca host (DISPOSABLE SERVE HOST, SCRIPTED CLIENT)
The worktree out/ (built 2026-10-27 14:17, the c4679d615 send path) ran by the worktree Electron in `--serve` mode. It used a disposable profile and home on
loopback 127.0.0.1:47394. The project was registered by `repo add` over the host's own runtime path. The client spoke the phone protocol,
subscribed as `client: {type: 'mobile'}` with the binary stream, and Claude ran in the Orca PTY against the fake API.
- Variant matrix, fresh Claude per variant: phone bundled long shape **0 admitted in 3 of 3** with `accepted: true, bytesWritten: 167`.
  Split long shape admitted, and short bundled admitted. Clientless short/long and desktop `agentPrompt` long were all admitted.
- Committed live test `mobile-agent-send-admission.live.test.ts`, run at 16:11. The control (split) was admitted: 2 provider requests and the
  TUI printed `● ok`. The phone's shape on the same handle got 0 provider requests, the nonce sat on the `❯` line, and the host replied
  `accepted: true`. The test failed with `the agent turn exists: expected 0 to be greater than 0`.
- Harness note: input sent within ~2 s of Claude's first prompt render dropped Enter even for the admitted shape (the first live run).
  The test now waits 2.5 s + 1.5 s after subscribe. This is a readiness confound of the harness, not the defect.
- Teardown: the serve host was stopped. No electron.exe, and no PowerShell or claude.exe child of the host, survived. Its pairing existed only in the
  disposable profile, so no device was left on any real host.

## Hypotheses

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | Bytes land but the TUI never submits | **CONFIRMED, refined** | The cause is not Enter timing (`\r` at 3 s still fails) and not emoji. It is the Ctrl+U prefix bundled into a paste-sized body. Planes 1-3. |
| H2 | Stale or wrong PTY | REJECTED | Owner evidence: the text is on the right tab. Plane 3: the nonce is on the exact handle's input line. |
| H3 | Ack loss, bubble held 'unknown' | REJECTED | The host replies `accepted: true` every time, so the phone takes the `acceptSend` path, not `holdUnconfirmedSend`. The Owner's bubble showed no pending state. |
| H4 | Lease or floor loss | REJECTED | The send was accepted with `client: {type:'mobile'}` after subscribe, and the Owner's desktop showed the phone holding the floor. A refusal would restore the draft and toast. |
| H5 | Phone/desktop version skew | REJECTED | Chat-send bytes are identical in ac525502f and c4679d615. The diff touches only draft settling for non-chat sends and the desktop-only reclaim RPC. |

## RED

- Deterministic, at the owner: `mobile/src/session/mobile-native-chat-send-admission.test.ts`, 2 tests, both FAIL with
  `expected '\u0015podrías revisar…' to be 'podrías revisar…'`. The other 28 send tests pass in the same run.
  Runner: `mobile/` deps are not installed on this laptop, so the files ran from a mirror without the expo tsconfig (`vitest run` with a
  minimal node config). On GEX44 the normal mobile runner applies.
- Live: `src/main/runtime/mobile-agent-send-admission.live.test.ts` (env ORCA_LIVE_PAIRING, ORCA_LIVE_REPO_PATH,
  ORCA_LIVE_FAKE_API_PORT; the host's Claude must point ANTHROPIC_BASE_URL at that port; evidence/13-serve-host.ps1 is the recipe).
- Existing tests that pin the defect and must change in phase 14: `mobile-native-chat-send.test.ts` "prepends the input-line clear
  byte" and "still prefixes only a single Ctrl+U" (both expect `'\x15hello'`).

## Gates
- `tsc -p config/tsconfig.node.json --noEmit`: exit 0 (includes the live test).
- `oxlint` on both new test files: exit 0.

## For phase 14 (not decided here)
Two fix shapes passed: (a) the clear as its own write, then the body, from the phone (works with every shipped host); and
(b) mobile chat routed through the host's settled agent-prompt path (bracketed paste + render gate), which today is desktop-only. That
needs a capability check for older hosts. Separately, the bubble is rendered from the PTY write receipt. That is the delivery-evidence defect phase 14 owns.
Codex was not measured (not installed on this laptop).
