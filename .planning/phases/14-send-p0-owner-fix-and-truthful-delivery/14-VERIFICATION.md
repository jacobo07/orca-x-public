---
phase: 14
status: passed
verified: 2026-10-27
residual: refusal REASON detail is not shown (a generic "Message not sent"), carried to phase 15, which owns refusals. Real-phone proof belongs to phase 16.
---

# Phase 14 verification: owner fix and truthful delivery states

Commits: 4e00f6e22 (send fix), a07d1d195 (delivery evidence), plus this close (live test retarget + records).

## Criterion 1: the RED is green, the fix sits in the owning layer, Law 2 holds. PASS
- `mobile-native-chat-send-admission.test.ts` (the phase 13 RED, contract "a body write carries no clear
  byte", which is the measured admitted shape): 2/2 pass. Phase 13 recorded it failing on the bundled
  code, so the test can return the other answer.
- The fix lives in `mobile/src/session/mobile-native-chat-send.ts`, the phone's chat-send owner. There is
  no host or wire change and no generic send.
- Admission of the split shape through a real Orca host: phase 13 plane 3 (DISPOSABLE SERVE HOST,
  SCRIPTED CLIENT). Split was admitted 3/3, and the committed live run at 16:11 admitted it (2 provider requests, `● ok`).
  `mobile-agent-send-admission.live.test.ts` now asserts that the shape the phone writes is admitted.
  It was not re-run in this phase (no new host behaviour to observe). Physical phone: phase 16.

## Criterion 2: written is distinct from delivered, unconfirmed comes after a bound, no duplicate. PASS
- `mobile-native-chat-delivery-evidence.test.ts`: a bubble starts `written`. Only the bubble whose bound
  passed turns `unconfirmed`. A retired bubble is never resurrected. Transcript turns carry no delivery
  state. The two captions differ, and neither says "sent".
- `use-mobile-native-chat-drafts-delivery.test.ts` (fake timers): written until 20 s, then unconfirmed at
  the boundary. The echo removes it and the bound cannot bring it back. The timer ends on unmount.
- `MobileNativeChatView.test.ts`: a pending row receives `delivery`, and a transcript row receives none.
- No duplicate: there is no Retry affordance. The unconfirmed copy tells the user to check the desktop
  before resending. The ack-lost hold is unchanged.

## Criterion 3: a host refusal is never rendered as sent. PASS
- A rejected outcome restores the draft and shows "Message not sent", and `acceptSend` is never called
  (existing tests in `use-mobile-native-chat-message-send.test.ts`, which pass). A refused clear now
  aborts before the body: `mobile-native-chat-send.test.ts` "never sends the body when the clear write is
  refused".
- RESIDUAL: the reason (lease, auth, stale handle, capability) is collapsed into `'rejected'` in
  `sendMobileNativeChatMessageWithOutcome`. It is never shown as success, but the narrowest recovery is
  not named. Phase 15 owns refusals (wrong target, revoked, older host) and takes this.

## Gates
| Gate | Plane | Result |
|---|---|---|
| mobile `vitest run src/session` | GEX44 disposable root /tmp/orca-phone-p14-20261027163437 (removed) | 148/148 files pass |
| mobile `tsc --noEmit` | GEX44 | exit 2 with 3 errors, identical at baseline 6d2dcc3f4 (2 generated modules absent under --ignore-scripts, mobile-workspace-client.ts:142). 0 new |
| oxlint `mobile/src/session` | laptop | exit 0 (positive control: a `debugger` file was caught) |
| `tsc -p config/tsconfig.node.json` | laptop | exit 0 |
| send + admission + render-data + reconcile + evidence tests | laptop mirror | 53/53 |

UI captions were not visually captured (no emulator on this laptop, and GEX44 has no KVM). Tokens come
from `mobile-theme.ts` (`typography.metaSize`, `colors.textMuted`, `colors.statusAmber`, `spacing.xs`).
The visual check is folded into the phase 16 device leg.
