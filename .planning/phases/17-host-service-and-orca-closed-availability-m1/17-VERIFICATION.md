---
phase: 17-host-service-and-orca-closed-availability-m1
status: human_needed
verified: 2026-10-27
owner_bound:
  - "Task Scheduler leg (disposable task): XML accepted, run, IgnoreNew, RestartOnFailure measured; restart-on-failure UNMEASURED"
  - "Install the autostart task on the Owner's real profile (packaged build of this branch)"
  - "Close the Owner's Orca UI and reach the host with serve running from the task"
  - "Phone off-LAN (5G) through the relay with the Owner's signed-in profile"
  - "Open the UI while serve runs: one window through the handover, still one runtime"
---

# Phase 17 Verification: Host Service and Orca-closed availability (M1)

Labels: **SCRIPTED CLIENT** = the phone protocol driven by a test on this laptop, not a phone.
**OWNER_BOUND** = only the Owner can perform it; the agent never closes, restarts or pairs to the
Owner's Orca X, and never writes the Owner's Task Scheduler without a recorded go.

## Success criteria

| SC | Claim | Evidence | Plane | State |
|----|-------|----------|-------|-------|
| SC1 | RED first: serve never started the relay | 17-01: serve-host-relay-wiring.test.ts RED then GREEN (17-01-SUMMARY.md) | unit | PASS |
| SC2a | serve starts the relay when cloud auth exists, `relay: unavailable` otherwise | 17-01 unit tests; live 1a readiness `{state:'unavailable', reason:'cloud_auth_not_configured'}`; live 1b with production cloud constants `{state:'started', status:null}` (no stored identity, cited no-network path) | unit + SCRIPTED CLIENT disposable host | PASS |
| SC2b | repeated starts never create a second runtime | live: plain duplicate exit 3, `--serve-autostart` duplicate exit 0, serve main processes 1, runtimeId unchanged over the client, second send FRESH (17-03-evidence.json) | SCRIPTED CLIENT disposable host | PASS |
| SC2c | a Windows logon Scheduled Task (restart on failure) starts serve | 17-02 builder + install/remove unit tests only; the real Task Scheduler leg was not run | unit | OWNER_BOUND (runtime half) |
| SC3a | UI never opened, serve running, paired client opens a terminal, unique command returns FRESH output, runtime count 1, idle RAM/CPU/startup recorded | host-service-orca-closed-leg.live.test.ts on JACOBO-PC: startupMs 18192, working set 346181632 B, private 277692416 B, CPU 0 at instrument resolution (positive control 100.6 % / 1.25 %), 4 processes, FRESH x2 `HOST JACOBO-PC win32` | SCRIPTED CLIENT disposable host | PASS |
| SC3b | the same on the Owner's PC with the Owner's profile and the Owner's UI closed | rows O1-O5 below | Owner PC | OWNER_BOUND |

The disposable host is not the Owner's installed Orca X: it ran the GEX44-built `out/` of 1ec6a6bd8 with the
worktree's electron.exe, a scratch userData/home/USERPROFILE, and loopback 127.0.0.1 only. The Owner's
`orca-devices.json` hash was identical before and after (39759f41...aa7b). No row claims off-LAN relay
reachability from the disposable host.

## Task Scheduler leg (17-03 Task 2)

| Item | State |
|------|-------|
| schtasks accepts the builder's XML | OWNER_BOUND (not run: no Owner go recorded in STATE.md) |
| positive control: status reads installed + ready | OWNER_BOUND |
| task launches on /Run | OWNER_BOUND |
| RestartOnFailure restarts after a non-zero exit (with latency) | **UNMEASURED** |
| IgnoreNew holds while a launch is alive | OWNER_BOUND |
| disposable task gone after teardown (with ScheduledDefrag positive control) | OWNER_BOUND |

Ready to run once the Owner says go: `ORCA_LIVE_SCHTASKS=1 ORCA_LIVE_SCHTASKS_ELECTRON=<worktree electron.exe>
ORCA_LIVE_SCHTASKS_EVIDENCE=<this dir>/17-03-evidence.json pnpm exec vitest run --config config/vitest.config.ts
src/cli/runtime/serve-autostart-task.live.test.ts`. The task is run-only (`trigger: 'none'`, no LogonTrigger),
named `Orca HAF Disposable <nonce>`, self-expiring (EndBoundary +60 min on a disabled TimeTrigger,
DeleteExpiredTaskAfter PT0S), and its action is a throwaway Electron app, not Orca. Whether Task Scheduler
expires a task whose only trigger is disabled is itself unmeasured; teardown removes it in `finally`.

## Owner steps (17-03 Task 3 checkpoint)

On the Windows host, with a packaged build of this branch installed (installing a build is Owner-only):

| Row | Step | State |
|-----|------|-------|
| O1 | `orca serve autostart install`, then `orca serve autostart status` shows installed and ready | OWNER_BOUND |
| O2 | Quit the Orca UI yourself, sign out of Windows and back in (or `schtasks /Run /TN "Orca Host Service (<user>)"`); status shows running; Task Manager shows one Orca process tree | OWNER_BOUND |
| O3 | Phone on 5G (Wi-Fi off): open the host, open a terminal, run `echo P17-<date>`; output appears fresh (needs the signed-in profile for the relay) | OWNER_BOUND |
| O4 | Open the Orca UI while serve runs: one window through the existing handover, no second runtime | OWNER_BOUND |
| O5 | Optional: end the serve process in Task Manager; note whether the task restarts it within 2 minutes (restartedOnNonZeroExit is UNMEASURED) | OWNER_BOUND |
| O6 | `orca serve autostart remove` if you do not want it kept | OWNER_BOUND |

Each row becomes OWNER-OBSERVED or REAL DEVICE only with the Owner's words and time.
