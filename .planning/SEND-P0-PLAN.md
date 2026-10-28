# SEND-P0: mobile remote send restored and proven end to end

Owner approved 2026-10-27 ("go"). Phases 13-16 in ROADMAP.md execute this file.

## Defect (Owner report)
Orca X Mobile opens the remote session and shows a new message locally. After Send, the
desktop conversation does not advance. Optimistic or local rendering may be happening without
confirmed remote admission. The Owner's screenshots were NOT attached to the arming conversation.
Ask once in STATE.md, and do not block on them.

## Laws (binding, from the Owner brief)
1. Optimistic render is not delivery. A button press, a store insert or an RPC attempt is not delivery.
   The owner of the remote effect must confirm it.
2. Conversation send and terminal send are different effects. They may share the composer, but
   effect ownership stays typed.
3. A remote send is scoped to device + host + project/worktree + session/runtime (+ generation or
   lease where relevant) + current authorization. Never fall back to the newest terminal, the active
   window, the default host or the last conversation when the request names a target.
4. 401/403/refusals are never empty success. Never reroute to another host or session to "make it work".
5. No store-and-forward that the architecture does not already support. A retry is duplicate-safe or it
   does not happen.

## Reality Scan facts (2026-10-27, at c4679d615)
- The mobile native-chat "Agent send" is `terminal.send` into the agent TUI PTY:
  `mobile/src/session/use-mobile-native-chat-message-send.ts` -> `mobile-native-chat-send.ts`.
  The sequence is Ctrl+U (or a sized clear as its own write), then the body, then `\r` about 500 ms later
  on the host (`src/main/runtime/orca-runtime.ts` writeTerminalAction).
- The host's `accepted: true` means the bytes reached the PTY (`orca-runtime.ts` sendTerminal). It does
  NOT mean the agent admitted a turn.
- The mobile renders the bubble from that write receipt: `acceptSend` on 'accepted', and
  `holdUnconfirmedSend` on 'unknown'. Only the transcript echo (`mobile-native-chat-pending-echo.ts`)
  proves a turn.
- For mobile, `isTerminalInputLockedForClient` is always false (`rpc/methods/terminal.ts`).
  `beginMobileInputFloor` needs the phone subscribed to that PTY, or still in its soft-leave grace.
  Otherwise it throws `mobile_input_floor_unavailable`.
- Installed builds differ: the desktop runs `c4679d615` (includes the 2-min lease `9b0de6a6c`), the
  phone APK is `ac525502f` (predates it).

FIRST MISSING RECEIPT (hypothesis to verify): between the PTY write being accepted and the agent
admitting the turn.

## Ranked hypotheses (phase 13 confirms or rejects each with evidence)
1. Bytes land but the TUI never submits: the Ctrl+U/body/`\r` timing, or provider paste detection
   turns `\r` into a newline. The nonce sits on the desktop input line.
2. The handle resolves to a stale or wrong PTY after the desktop reinstall or restart.
3. Ack loss: the bubble is held as 'unknown', with only a toast.
4. Lease or subscription loss makes `beginMobileInputFloor` null -> error. This contradicts a visible
   bubble. Still check it.
5. Phone/desktop version skew: diff `terminal.send` behaviour ac525502f..c4679d615.

## Method
- The primary RED is the real path. Scripted phone client (`src/main/runtime/mobile-protocol-test-client.ts`,
  the live-leg pattern of `mobile-live-windows-leg.live.test.ts`) against the Owner's installed
  Windows Orca X, on a real agent tab (Claude or Codex). Send a unique `ORCA-NONCE-<uuid>`. Capture:
  the RPC response, the host write (ptyId, bytes), the PTY output, the desktop input line, the
  transcript turn. The first stage without the nonce is the failing boundary.
  Evidence is labelled SCRIPTED CLIENT. Revoke the scripted device at the end and prove the revoke with
  a refused mutation. Never restart or close the Owner's windows or sessions.
- Then a narrow deterministic test at the failing owner. The contract is "the agent turn exists",
  never "the callback ran".

## Delivery-evidence state model (reuse the project vocabulary; no needless enum growth)
Write outcome stays `accepted | rejected | unknown`. Bubble evidence:
`sending` (no ack) -> `written` (PTY accepted, no echo yet) -> `delivered` (transcript echo matched);
`unconfirmed` (no echo within a bound); `refused` (+refusedReason: lease, auth, capability/version,
session not found, host unreachable); `failed` (definite rejection or disconnected).
A `written` bubble must never look identical to a `delivered` one. Retry checks the echo first, so it
never creates a duplicate turn.

## Done-gates
AGENT SEND: real phone, real paired host, real conversation, unique prompt, local row, host admits,
desktop receives, the canonical user turn persists, the provider starts or reaches a truthful external
boundary, the result reconciles on mobile, no duplicate user message, wrong host or session untouched,
disconnect/reconnect duplicate-safe, revocation refuses, mutation catches broken wiring.
TERMINAL SEND: real phone, real host, real terminal, unique command, exact PTY, fresh output (oracle
`src/shared/terminal-fresh-output-oracle.ts`, never history), desktop sees the same PTY, wrong
terminal untouched, lease semantics respected, reconnect duplicate-safe, revocation refuses.
COMBINED: open session -> Agent prompt -> desktop sees it -> streaming with stable scroll -> switch to
terminal -> send command -> fresh output -> background/foreground -> reconnect -> send again ->
desktop reclaim/revocation correct.

## Mutants (each PLANT_CONFIRMED / CAUGHT|SURVIVED|HARNESS_FAILED / RESTORE_VERIFIED)
send handler skips the RPC; bubble marked delivered on the write receipt; `\r` dropped; wrong host id;
wrong session id; refusal swallowed; lease-lost mapped to success; duplicate after reconnect;
canonical echo shown twice; runtime switch retargets a composed send; terminal send hits the newest
terminal; agent send requires the terminal lease; capability mismatch treated as success.

## Institutional close
Knowledge Vault incident ("written != admitted"); UKDL candidates (HR: a PTY write receipt is not
conversation admission; PR: nonce trace across every boundary; TRAP: a bubble rendered from a transport
ack), promoted only with evidence. Ratchet: a `check:*` gate. Every mobile surface that renders a
remote-effect bubble takes its state from the evidence presenter. The population is found by what the
code does, with a floor, and the list may only shrink. Fresh-agent test from durable state.
Two-layer handoff (Owner summary + engineering block) as in the brief.

## Token budget
Mission ~1.6M over ~6-8 cycles: archaeology/trace 120k, implementation 450k, Product Reality 350k,
mutation 200k, KV/UKDL 120k, rollover reserve 150k per cycle. The worker relays at the mission wall.
