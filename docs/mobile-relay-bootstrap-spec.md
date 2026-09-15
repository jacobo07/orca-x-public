# Mobile relay: why a direct-paired host can stay relay-less forever

Investigation record, 2026-09-14. Supersedes an earlier draft of this file that
claimed a bootstrap circularity in the relay transport. **That claim was wrong
and is retracted below**, along with what replaced it.

## What was observed

A user recording showed Orca X Mobile leaving the app for ~0.9s and returning to
splash → "Welcome back" → `Host 1 · Connecting…` → a one-group session list,
reaching the real 64-item list only ~8.8s after re-entry.

Measured on the real device (SM-S938B, Android 16, Orca X 0.0.43, versionCode 12):

- The process, the activity and the JS context **all survive** a background
  cycle: PID stable, same `ActivityRecord`, `ReactHost.onHostResume`. Not
  process death, not activity recreation. `always_finish_activities` is unset.
- What dies is the transport. On a healthy network the cycle was
  `Connected → Disconnected → Connecting… → Connected` in ~5.4s (n=1).
- The splash is Android choosing between a `SnapshotStartingWindow` and the
  splash-themed starting window; it is cosmetic and not evidence of a cold boot.
- Across 8 later cycles (24,797 logcat lines) every `[net] openConnection`
  dialled one pinned endpoint, `100.109.24.4:6768`, failing with
  `after 10000ms` each time, and **zero relay lines appeared**.

Those 8 cycles are **inconclusive for latency**: mid-run the phone lost its
route to the host (no Tailscale interface; the LAN path blocked because the
host's Wi-Fi adapter sits in the Windows Public firewall profile). They are
reported only as evidence about *which path was dialled*, never as a budget.

## Retraction

An earlier draft asserted: *"the machinery that could acquire a relay endpoint is
unreachable unless you already have one."* That is false.

`mobile-endpoint-lifecycle.ts` branches explicitly on the relay-less case: a host
with no `relay` is given a `MobileRelayDirectUpgradeController`, which calls
`upgradeDirectMobileRelay` over the healthy direct link — minting a fresh journal,
asking the desktop for endpoints, sending `pairing.provisionRelay` with only a new
resume-token hash, and persisting the result onto the host — and only then starts
the supervisor. The `!this.host.relay` early return in
`MobileEndpointSupervisor.start()` is a defensive no-op guarding a path that
production does not take for such a host.

What misled the earlier draft: `resolveRelay` *re-resolves* an existing
assignment rather than creating one, and `rotateMobileRelayCredential` requires
an existing bundle. Both genuinely cannot bootstrap. The third path —
`upgradeDirectMobileRelay` — can, and was not checked before the claim was made.

## What the gap actually is

`MobileRelayDirectUpgradeController.tryUpgrade` retries on every `connected`
transition and every foreground transition, and swallows failures:

```
} catch {
  // the journal survives transient auth/control failure; retry only on
  // the next authenticated reconnect or foreground transition.
}
```

That is right for a transient failure. It is indistinguishable from a
**permanent** one. Two permanent outcomes are silent:

- the desktop answers `method-not-found` → `clearJournal`, return `null`, and the
  controller retries forever;
- the desktop offers no relay endpoint → `relay endpoint unavailable for direct
  pairing upgrade` is thrown, caught, retried forever.

In both, a host silently never gains a second path. Nothing is logged, nothing
reaches the UI, and the user discovers it only when the direct route drops — at
which point they wait out repeated 10s connect timeouts with no indication a
fallback was ever meant to exist. The desktop side is built
(`src/main/runtime/relay/desktop-relay-service.ts`) and gated behind
`relay-auth-context` / `relay-auth-coordinator`, so an un-provisioned desktop is a
reachable, ordinary state.

**Open, not concluded:** whether this particular desktop advertises a relay at
all. That is the next measurement, and the leading explanation for every relay
observation above.

## Adjacent finding, independently true

`connection-health.ts` escalates to `Can't connect — check Tailscale` only after
`WARNING_ATTEMPTS = 3`. With a 10,000ms connect timeout that is ~30s of
`Connecting…` before the user is told anything actionable. The grace period is
counted in attempts while its cost is measured in seconds.

## What was committed, and what it proves

`mobile/src/transport/mobile-endpoint-supervisor-relayless-host.test.ts`
(commit `0eef37317`) pins that the supervisor arms nothing for a relay-less host,
with a positive control proving the harness can observe a relay dial.

Given the retraction, its scope is narrower than its commit message claims: it
characterises the **defensive branch**, not the defect. It is still worth keeping
for the second thing it documents — `mobile-endpoint-supervisor-test-fakes.ts`
exports one shared `host` that always sets `relay` and `relayHostId`, so every
test in that subsystem supplies a precondition production may lack, and none can
observe a relay-less host.

That commit message is not amended: this branch is shared with another pane, and
rewriting history under a live writer is worse than a mis-stated message. This
file is the correction.

## Not done

- No fix has been written.
- No healthy-network latency budget exists; the device had no route to the host
  when the characterisation ran, and that gate stays open.
- The frozen-spinner defect (92 consecutive frames with zero pixel change while
  opening a session) is separate, real, and untouched.
