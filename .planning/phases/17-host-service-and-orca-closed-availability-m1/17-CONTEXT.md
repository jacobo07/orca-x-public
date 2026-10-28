# Phase 17: Host Service and Orca-closed availability (M1) - Context

**Gathered:** 2026-10-27
**Status:** Ready for planning
**Mode:** Smart discuss, autonomous. Grey areas resolved from the Owner-approved brief
(`.planning/HOST-AVAILABILITY-PLAN.md`, "Aprobado" 2026-10-27); where the brief is silent the recommendation
below was taken and is marked (rec).

<domain>
## Phase Boundary

`orca serve` becomes the Host Service. A paired phone reaches and uses a host whose Electron UI is closed, with no
desktop interaction. In scope: serve starts the cloud relay, serve reports relay/version/capabilities in its
readiness, a Windows logon Scheduled Task that starts serve and restarts it on failure, idempotent starts.
Out of scope (later phases): power/orca/connectivity state model and host card (18), WOL and broker (19), off-LAN
wake and OOB (20).

</domain>

<decisions>
## Implementation Decisions

### Relay in serve (brief decision 2)
- D-01: One relay-startup owner for both modes. Extract the desktop block at `src/main/index.ts:3462-3493` into a
  named module (e.g. `src/main/runtime/relay/host-relay-startup.ts`) and call it from the serve branch before
  `printServeReady` and from the desktop path. No second relay implementation.
- D-02: Build without cloud config (`getOrcaCloudAuthConfig().configured === false`) or a constructor failure
  (`mobile_runtime_not_ready`) yields `relay: { state: 'unavailable', reason }`. Never a faked "connected".
  Signed-out/standby/offline stay the broker's own `MobileRelayStatus`; serve does not reinterpret them.
- D-03: `powerMonitor.on('resume', ensureLive)` and the `fenceAndCloseNow` quit/relaunch/sign-out fences apply to
  the serve-started service exactly as to the desktop one (same module-level `desktopRelayService`).
- D-04: After serve promotes to a desktop window (existing `ServeDesktopActivationGate`), the desktop branch is not
  re-entered, so there is still exactly one relay service.

### Readiness (rec)
- D-05: `ServeReadiness` gains additive fields `appVersion` and `relay` (`{ state: 'started', status }` or
  `{ state: 'unavailable', reason }`), rendered in human and `--json` modes; recipe-json output unchanged.
  Capability fields beyond this belong to phase 18.

### Windows autostart (brief decision 1)
- D-06: A Scheduled Task at user logon (current user, interactive session, LeastPrivilege), not a Windows Service
  and not the Startup folder. Built from a pure, unit-tested XML builder; registered with `schtasks.exe /Create
  /XML`; removable and queryable. `MultipleInstancesPolicy=IgnoreNew`, no battery stop, no execution time limit,
  `RestartOnFailure` with a bounded count.
- D-07 (rec): The task must not restart-loop while another Orca instance holds the single-instance lock. Manual
  `orca serve` keeps exit code 3 on a held lock; the autostart launch path treats "lock held by a live Orca" as
  satisfied (exit 0) so RestartOnFailure fires only on real failure.
- D-08 (rec): Surface it as CLI subcommands under `orca serve` (`autostart install|remove|status`); non-Windows
  returns a clear unsupported result pointing at the Linux systemd doc. No desktop UI in this phase.
- D-09: Installing the task on the Owner's real PC and closing the Owner's Orca UI are Owner-affecting actions:
  the live leg runs on a disposable serve host where possible, and the Owner-PC leg is recorded OWNER_BOUND until
  the Owner runs it (laws in STATE.md: the Owner's windows and sessions are never restarted or closed by the agent).

### Proof
- D-10: RED first: a test that fails on the current tree because the serve branch never reaches relay startup.
- D-11: Idempotent start: a second serve launch exits 3 and the runtime count stays 1 (single-instance lock,
  `src/main/startup/single-instance-lock.ts`).
- D-12: Live leg (criterion 3) labelled SCRIPTED CLIENT; records idle RAM, CPU and startup time of serve.
  Off-LAN relay reachability needs the Owner's signed-in profile: OWNER_BOUND if not measurable unattended.

### Claude's Discretion
File names, test layout, exact task XML values (restart interval/count), human-mode wording (through existing
patterns; CLI output is not i18n'd today).

</decisions>

<code_context>
## Existing Code Insights

- serve branch: `src/main/index.ts:3333-3411` returns before the relay block at 3462-3493.
- Relay: `src/main/runtime/relay/desktop-relay-service.ts` (`start`, `ensureLive`, `authMutated`,
  `fenceAndCloseNow`); statuses `src/shared/mobile-relay-status.ts`; cloud config
  `src/main/orca-profiles/profile-cloud-auth-config.ts:66`.
- Readiness: `src/main/server/serve-readiness.ts` (+ test). CLI spec `src/cli/specs/serve.ts`; launcher
  `src/cli/runtime/launch.ts` (+ `launch.test.ts`).
- Desktop handover: `src/main/startup/serve-desktop-activation.ts`; window-all-closed keeps serve alive
  (`src/main/startup/window-all-closed-quit-policy.ts`).
- Structural wiring tests read `src/main/index.ts` source (`serve-desktop-activation-wiring.test.ts`): same style
  fits the RED test.
- Recurring work: the relay liveness interval is an existing producer; serve reuse must not add a new unclassified
  one (`pnpm check:recurring-work`).

</code_context>

<specifics>
## Specific Ideas

- Laws: the machine is the node, not the UI; unreachable is not powered off; no button without a backend effect.
- Laptop: 8 GB; single vitest files only here, heavy runs on GEX44 in a disposable root.
- Never push; never touch `C:\owx-pc`, `C:\ox` or the primary checkout.

</specifics>

<deferred>
## Deferred Ideas

- Desktop Settings toggle for autostart (after phase 18 capabilities exist).
- macOS LaunchAgent autostart.
- Handing a desktop-only instance over to serve when the desktop quits.

</deferred>
