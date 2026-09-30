# Phase 5 - GEX44 node manifest measurement

Verdict: BLOCKED. Rung reached: `preflight`. Reason: deploy-failed: ...lready ours POSTURE ufw-state POSTURE Status: inactive POSTURE sandbox-mode POSTURE no-sandbox (accepted contingency, T-02-05) fatal: detected dubious ownership in repository at '/home/orca-svc/dws-p2/e625d3f' To add an exception for this directory, call: System.Management.Automation.RemoteException git config --global --add safe.directory /home/orca-svc/dws-p2/e625d3f INSTALL_FAILED step=checkout.
HEAD e625d3f42cd44fa89de32b5f5ee5bea5f9211511, run 2026-09-30T04:46:53.7703839Z .. 2026-09-30T04:47:22.6377636Z. No plane tag is claimed and no laptop number stands in for a GEX44 value.

## Named debt
- ND-1: the legal lane is the Orca bundle+ssh evidence lane until UWCP S5's dispatcher lands.
- ND-2: the laptop-to-GEX44 ssh -L forward, retiring with the dispatcher-owned tunnel.

## What happened on GEX44 (recorded, not repaired)
Three lane runs of Publish-DwsServeBuild reached the install step at e625d3f42 and failed: (1) sandboxed default, the unit exited status=133 five times and systemd hit its start limit; (2) and (3) with -NoSandbox (the posture the previous unit ran), install stopped at checkout with git "detected dubious ownership" on /home/orca-svc/dws-p2/e625d3f, the same message twice, so the ladder stopped there (Regla 12). orca-dws-serve.service was active (MainPID 1181474) before the first install and is `failed` (MainPID 0) now; nothing was deleted and no reset-failed/start was run because only the lane is authorized. Restoring it needs `reset-failed` plus a safe.directory fix for orca-svc, an Owner/orchestrator action. The GEX44 disk stayed at 99% used (32G available). No reading was taken, so no plane tag and no laptop number stands in for a GEX44 value.
