---
covers:
  - mobile-workstation-runtime
  - voice-transcript-target-ownership
  - terminal-launch-profile-identity
  - cross-device-driver-authority
  - terminal-smart-copy
  - terminal-inspector
  - mobile-adaptive-workspace
  - mobile-connectivity-truth
  - mobile-agent-operations
  - terminal-resource-lifecycle-contract
status: active
opened: 2026-09-15
branch: orca-x/mobile-workstation-runtime
base: de665e350
---

# Mobile Workstation Runtime — program spec

## Objective

An engineer can continue real work from a phone across agents, shells, TUIs, source
control and host resources **without losing the identity, authority, continuity or
truth available on desktop**. The mobile presentation may differ from desktop. The
semantics may not.

Observable when done: every high-authority mobile action terminates at a canonical
subject identity captured before any asynchronous work begins; no view lifecycle
event destroys work; and every capability this program touches carries an explicit,
gate-enforced mobile disposition.

## Governing laws

1. **Desktop and mobile are two projections of the same canonical capabilities.**
   Mobile is not a downstream approximation.
2. **View destruction and work destruction are different operations.** Losing a
   socket, a WebView, a process or a device must never kill a PTY or an agent.
3. **Authority and identity chosen upstream must survive every projection that a
   later decision relies on.** No downstream reconstruction from mutable state when
   the upstream truth existed and was discarded.

## What the reality scan falsified

This program was scoped as if five things needed building. They exist. Recording
this is the single most valuable output of Wave 0, because each one would otherwise
have been rebuilt as a weaker parallel authority.

| Assumed missing | Actually |
|---|---|
| Cross-device Follow / Take Over / Independent | `RuntimeTerminalDriverState` (`src/shared/runtime-types.ts:59-62`) — one driver per PTY, three kinds, shared across main/preload/renderer so variants cannot drift |
| View-vs-work lifecycle separation | `terminal.subscribe`/`unsubscribe` are distinct allowlisted methods from `terminal.close`/`closeTab`; stream teardown (`src/main/runtime/rpc/methods/terminal.ts:2079-2086`) drops four listeners and the stream, never the PTY |
| Parity disposition as construction law | `config/variant-parity.jsonc` + two shrink-only baselines + `config/scripts/check-variant-parity.mjs`, wired into `pnpm lint`. The unknown baseline is **empty** |
| Mouse-mode gating before mouse routing | `src/main/daemon/terminal-mouse-mode-mirror.ts` tracks 9/1000/1002/1003/1006/1016; mobile mirrors PTY modes synchronously from the WebView |
| Copy-last-command-and-output is a wiring job | It is **not derivable**. `src/shared/terminal-osc133-command-finished.ts` parses `C` and `D` — command start/finish events with an exit code — but no `A`/`B` prompt markers and no text region. Nothing maps an event to a buffer range |

The design contract for the first of these had been deleted as an "ephemeral doc"
while six code comments still cited it. Restored in `2dd8915bd`.

## Ownership — what this program may extend, and what it may not create

It creates **no** terminal runtime, source-control engine, agent engine,
connectivity engine or resource-management authority. It composes existing owners
and supplies mobile interaction, presentation and orchestration.

| Concern | Canonical owner |
|---|---|
| Terminal work authority | `src/main/runtime/` + providers; a view never owns a PTY |
| Buffer / headless emulation | `src/main/daemon/headless-emulator.ts` (visible lines, buffer tail, snapshot with scrollback) |
| Command lifecycle | `src/shared/terminal-osc133-command-finished.ts` |
| Cross-device authority | driver state + presence lock in `src/main/runtime/orca-runtime.ts`; contract in `docs/mobile-presence-lock.md` |
| Mobile terminal surface | `mobile/src/terminal/` |
| Mobile transport | `mobile/src/transport/` |
| Resource sleep | the resource-aware-sleep workstream; mobile **consumes** its decision and never re-derives safe-to-kill |
| Parity governance | `config/variant-parity.jsonc` and its gate |

## Gaps this program closes

From the parity ledger at `de665e350` — four measured-open, zero unknown:

| id | sev | gap |
|---|---|---|
| `voice.transcript-target-ownership` | P1 | a transcript can land on the surface focused when ASR completes, not the one that started recording. The ledger records that **no test pins any of this** — the race's existence is established, its width is not |
| `runtime.command-acts-on-the-window-that-owns-the-target` | P1 | the graph-owner layer's safe answer is null, and the next layer reads null as "everyone" |
| `drafts.user-invested-input-survives-process-death` | P1 | unsent composed text dies with the app |
| `terminal.launch-profile-identity` | P2 | `launchProfileId` is dropped before mobile projection. Becomes release-critical the day a relaunch-from-this-tab affordance lands — i.e. the day the action bar ships |

Carried in from the mobile relay investigation (`docs/mobile-relay-bootstrap-spec.md`):

- `MobileRelayDirectUpgradeController.tryUpgrade` treats a permanent failure exactly
  like a transient one, so a relay-less host reaches roughly 30 s of "Connecting…"
  before anything actionable appears.
- A frozen spinner: 92 consecutive frames, zero pixel change, positive control
  confirmed. Untouched.

## Donor disposition — LaptOps

Audited at `b3cb27e`. **Zero donor source is adopted.**

The decisive finding: in LaptOps the WebSocket handler owns the PTY. `PtyHandle`'s
`Drop` issues `child.kill()` (`apps/host/src/pty_server.rs:78-93`), the WS handler
holds that handle and drops it on exit (`apps/host/src/http_server.rs:4430-4434`),
and the session registry is metadata-only and explicitly never holds the child
(`pty_server.rs:31-33`) — so there is nothing to reattach to. A dropped connection
destroys the user's work. Orca does the opposite, and Wave 13 pins it so it stays
that way.

Two donor patterns are adopted as *intent*, not mechanism: the copy-last-output
affordance (its heuristic — reset the buffer on the next keystroke,
`useTerminalSocket.ts:169-173` — is unsound for an agent TUI, where every arrow key
resets it) and the per-phase runnable evidence probe.

One donor shape is recorded as forbidden: a per-pane target that falls through to a
global active-host chain when null (`TerminalCell.tsx:35-36`). That is the same
defect as the open P1 above, and it must not enter through the workspace wave.

## Waves and done-gates

A wave closes on its gate, never on "the implementation exists".

| # | Wave | Done-gate |
|---|---|---|
| 0 | Reality scan, contract recovery, this spec | Ownership map committed; presence-lock contract tracked; scan falsifications recorded |
| 1 | Voice target ownership | A transcript started on subject A reaches A or is refused; reverting the capture makes it land on B, **red** |
| 2 | Launch-profile lineage | The field survives projection; a test distinguishes recorded from inferred and fails if the distinction collapses |
| 3 | Composition boundary | Named boundary + ownership doc. No new runtime |
| 4 | Terminal Inspector | Every field labelled recorded vs inferred; unknown renders as unknown, never as a default |
| 5 | Smart Copy | Advertised modes produce the advertised material; clipboard success is verified, not assumed; unsupported modes are **absent with a reason**, never guessed |
| 6 | Action bar + ergonomics | Interaction inventory taken from source before any control changes shape; every item has a destination |
| 7 | Connectivity truth + relay defect + frozen spinner | States are distinguishable from real evidence; a permanent failure stops being reported as a transient one |
| 8 | Cross-device postures | Extend the driver state machine along its own stated forward path; takeover races pinned |
| 9 | Adaptive workspace + per-pane host | One pane changing host cannot retarget another; no null-inherits-global target |
| 10 | Agent Operations | A notification routes to the exact agent subject, never to last-active |
| 11 | Resource sleep control | Mobile consumes host authority; unknown is never reinterpreted as safe |
| 12 | Pocket Dev | Mutations keep canonical stale-state fencing |
| 13 | Lifecycle contract | Losing a transport, a WebView and the mobile process each leave the PTY alive, against a real PTY, with a control that an explicit close still closes it |
| 14 | Parity governance | A synthetic capability with no disposition fails the gate; one with a disposition passes |
| 15 | Whole-program reality, perf, failure injection, distillation | §51 clauses, debt classified |

Waves 0–2 are approval-critical: nothing with elevated authority ships before the
identity gaps close.

## Wave 8 is execution, not design

`docs/mobile-presence-lock.md` maps the three requested postures onto mechanisms
that already exist. Follow is subscribing in desktop display mode — "a passive
watch, not a take-floor gesture" (l.119-125). Take Over is the transition to
`mobile{clientId}`, which "engages on _interaction_, not on _presence_". Follow is
already read-only *at the authority boundary* rather than in the UI: the renderer's
mirror is stale for one IPC hop, which is why the server-side write and resize
defenses are "load-bearing, not redundant" (l.88-96).

The document then names its own forward path (l.680-692): unify the desktop
renderer's write IPC and mobile's `terminal.send` behind one runtime-owned write
path, using the current driver as the admission predicate, **without a wire-format
change**. That is exactly the Independent posture, specified and deferred, with its
prerequisite already shipped.

## Non-goals

- No second layout, pane, session, transport, clipboard, agent, source-control or
  resource authority.
- No mobile-only node-URL abstraction over host routing.
- No posture, state or vocabulary added because it sounds useful. If a stronger
  Orca model covers it under another name, extend that model rather than alias it.
- No editor. Mobile optimizes for inspect, decide, approve, intervene, and return
  to the terminal.

## Test and Product Reality contract

- RED before fix, driven by the wrong-target or severed-link case rather than the
  happy path.
- Every safety claim carries a mutation that severs the protection, a byte-exact
  restore verified by hash, and a liveness control that must stay green.
- Every "it did not happen" assertion is paired with an "it does happen" control in
  the same harness. A destruction that never ran and one correctly refused leave
  identical evidence.
- No absence assertion keyed on a translated string. This host runs Spanish; a
  locale-dependent selector is a permanent silent pass.
- Product Reality per wave at the strongest affordable layer, classified honestly as
  software debt, environmental debt, or external limit.
- No mobile Product Reality claim without tracing HEAD → build → bundle → installed
  app → running process.

**Known environmental debt at open:** the test phone currently has no route to the
host (no Tailscale interface; LAN blocked by the host's Public firewall profile).
That is environmental, not an external limit, and it does not excuse an unrun
emulator path.

## Concurrency

This program runs in its own worktree (`C:\Users\User\Apps\orca-mobile-wt`) off
`origin/main`. The primary checkout is running a daemon and durability mission with
a live writer inside `src/main/daemon`, which this program must not touch. Isolation
is the reason the two can share `src/main/runtime` without a wide oracle becoming
unattributable.

## Rollback

Every wave is a set of semantic micro-commits on one branch, bisectable and
individually revertible. Nothing in Waves 0–8 changes a wire format; the Wave 8
forward path is explicitly specified as not requiring one. Any wave that turns out
to need a wire change stops and follows
`docs/reference/remote-wire-compatibility.md` before proceeding.
