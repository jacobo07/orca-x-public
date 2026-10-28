# Row 70 — Continue here over a real SSH target (live, 2026-10-17)

Plane: REAL-SSH. Laptop (Windows, e2e build, electron-headless) to GEX44 through a provisioned
disposable root `/tmp/orca-hwf-p17-20261017T212515Z` and an `ssh -L` carrier; nothing written to
`orca-dws-serve.service`.

Command: `C:\Users\User\Apps\rbl\run-leg.ps1 -Row 70 -Tag r70b -Specs tests/e2e/hwf-two-host-continue-here-ssh.spec.ts -SeedVerb none -PathEnv none`
(resource admission, then `d4-live.ps1`, then a log-only verdict). Evidence directory
`C:\Users\User\Apps\rbl\d4-ev-r70b-20261017-232515`.

## Result: 1 passed (1.8 m)

| Leg                      | Observed                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One project across hosts | `HWF70_PROJECT git-root:0a8c5380… hosts=local,ssh:…` — the laptop replica and the GEX44 replica share a root commit and the app grouped them; nothing was written into the store |
| Disconnected target      | `HWF70_DISCONNECTED_REFUSED PASS` — status `refused`, tone `problem`, no pane rows, tab counts unchanged                                                                         |
| Reconnected, same click  | `HWF70_RESTORED {"count":3,"dormant":3,"withProcess":0}` — restored rows are dormant, no PTY                                                                                     |
| Pane dispositions        | `["restart/relaunchable","unavailable/nothing-runnable","unavailable/nothing-runnable"]`                                                                                         |
| Open on the restart row  | `HWF70_OPENED host=kobicraft-gex44 pwd=/tmp/orca-hwf-p17-20261017T212515Z/repos/p16-replica` — a shell on the owning host in the remote workspace                                |
| Teardown                 | `TEARDOWN_EXIT=0`, `REMAINING=0`, `PROC_COUNT=0`, witness unchanged                                                                                                              |

## Red before green

Run r70a (`d4-ev-r70a-20261017-214707`) failed: the Continue target picker never rendered. The spec had
written the local project's id onto the remote setup, and `normalizeHydratedProjectHostSetupProjection`
re-derives a setup's projectId from its repo identity, so the e2e temp repo and the GEX44 replica
stayed two projects. The spec now opens two clones with one root commit and asserts the grouping the
product computes.

## Not covered (why row 70 stays PARTIAL)

- `reattach`: `planContinueOnHost` (src/shared/project-working-set-host-translation.ts) gives it only when
  the pane's agent session reads `live-here` on the target (live agent session presence). This leg has
  no agent pane. A leg needs an agent session saved in the working set and live on GEX44 at Continue time.
- `resume`: needs an `exact-resume` provider session on GEX44, which a real model turn creates (OD-1).
