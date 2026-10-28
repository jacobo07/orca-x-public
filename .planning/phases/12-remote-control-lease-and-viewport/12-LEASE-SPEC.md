---
covers: [mobile-driver-lease, observe-only-lease-expiry, reclaimIfPhoneIdle]
phase: 12-remote-control-lease-and-viewport
approved: 2026-10-27 (Owner: "adelante con la caducidad")
---

# Spec: phone control lease expires when the phone only watches

## Problem

A paired phone that subscribes to a terminal becomes its driver, and the driver role is held for as long as
the subscription lives, even if the phone never types again. The desktop then drops every keystroke and shows
the explanation, so the user has to click Take back on their own computer to use a terminal the phone is only
watching.

## Behaviour

- The **lease** is the newest phone action on that terminal: subscribing, sending input, taking control, or a
  viewport change such as the phone keyboard opening (`lastActedAt` across every phone subscribed to the PTY).
- While the lease is **active** (newer than `MOBILE_DRIVER_LEASE_MS`, 2 minutes) nothing changes: desktop
  keystrokes are dropped and the explanation opens, exactly as today.
- Once the lease has **expired**, the first desktop keystroke takes the terminal back, through the same
  take-back the button uses. That keystroke is the gesture and is not delivered; later ones are.
- An in-flight phone write keeps the lease active.
- **Not touched:** a driver with no phone subscribed (stale lock, held phone-fit). These keep their explicit
  Take back / Restore, because a held fit is a deliberate setting.
- After a lazy reclaim the phone behaves as after Take back: its next action takes the terminal again.

## Authority

The host decides. `OrcaRuntimeService.reclaimTerminalForDesktopIfPhoneIdle(ptyId)` judges the lease via
`src/shared/mobile-driver-lease.ts` and calls `reclaimTerminalForDesktop`. It is reached by:

- local desktop: IPC `runtime:reclaimTerminalIfPhoneIdle`
- remote runtime (SSH or a paired host): RPC `terminal.reclaimIfPhoneIdle`

## Compatibility

- **New method, no wire change to existing ones.** An older host answers `method_not_found`. The renderer
  treats any failure as "not reclaimed", so the keystroke stays dropped, which is today's behaviour.
- The phone app is unaffected.

## Cost

- No timer and no poll. The check runs only on a dropped desktop keystroke.
- The renderer keeps at most one request in flight per PTY, and after an "active" answer it does not ask again
  until the remaining lease has passed.

## Acceptance

1. Lease active: no reclaim; the driver stays with the phone; the answer carries `retryAfterMs`.
2. Lease expired: the driver becomes desktop.
3. A phone write in flight: no reclaim.
4. No phone subscribed: no reclaim, whatever the age.
5. Two phones: the newest action of either one renews the lease.
6. The renderer sends one request for a burst of keystrokes and honours `retryAfterMs`.
7. An unknown method or a transport failure: no reclaim, and the renderer does not throw.

## Rollback

Revert the commit. The new IPC and RPC disappear, and the renderer path is a single call site in
`pty-connection.ts`.
