# Phase 5 - GEX44 node manifest measurement

Verdict: MEASURED at rung `gex44-local-caller` on 2026-09-30T04:55:07.9319001Z .. 2026-09-30T04:56:18.1080801Z, HEAD 6e036d7ccec3e6b4ea5e31c5109ca6349e7723d3.
Artifact sha256 (laptop == GEX44): 3c68024e33b83f6fd8e47ff37b4a995d0d974b356088ea78ec4f78c521d9cf04. runtimeIdMatchesServe: true.

| family | verdict | reason | product value | plane tag |
|---|---|---|---|---|
| memory | MATCH |  | 52938711040 | GEX44-PROVEN |
| vram | MATCH |  | 3202351104 | GEX44-PROVEN |
| disk | MATCH |  | 32911593472 | GEX44-PROVEN |
| resident_model | UNJUDGED | control-missing | qwen3-coder-30b | GEX44-PROVEN |

Each value was read by the product (`orca fleet manifest` run in a terminal on GEX44) and independently by an ssh control (free, nvidia-smi, df, curl /v1/models), judged with tolerances:
- memoryAvailableFraction = 0.1: available memory drifts with page cache between two readings seconds apart
- memoryAvailableMinBytes = 536870912: floor for the fractional tolerance so a small host is not held to a few MiB
- vramFreeBytes = 268435456: two other tenants (llama-server, ComfyUI) allocate on the same GPU
- diskAvailableBytes = 1073741824: a 99%-full shared filesystem moves by hundreds of MiB per minute
- modelIds = exact-set-equality: a model id is either served or it is not

Probe port 8081 came from the control run's loopback listener list, not from a code default.
Disk fact for planners: 30.65 GiB available, 98% used on `/` at the control reading.

## Rung and what it does not prove
Rung `gex44-local-caller` is the built CLI running ON GEX44 (real product path through observeLocal), exactly the phase-2 row-18 recipe. It does NOT prove the laptop fan-out through callEnvironment (a laptop-local runtime observing gex44-svc). Fan-out: not attempted: SPIKE-CLI-TARGET names the desktop default profile as the laptop-local runtime; orcaProcesses=1, and starting a second Electron runtime on a laptop with 5176.7 MB free (out/ is the Linux build) was not authorized.

## Why resident_model is UNJUDGED (2026-09-30)
The control did read `qwen3-coder-30b` on :8081, but llama-server's `/v1/models` body has no trailing newline, so the next section marker joined the JSON line and the parser saw no model ids. Fixed in 3266e1a41 (the control script ends the body; a test built from the real glued shape goes red without it). The re-measure at 3266e1a41 reached step 3 (redeploy and artifact hash equal at both ends) and was then stopped by the host's low-memory reaper, so the resident-model comparison is still owed. The product value above is a real GEX44 reading; only its independent control is missing.

## Named debt
- ND-1: the legal lane is the Orca bundle+ssh evidence lane until UWCP S5's dispatcher lands.
- ND-2: the laptop-to-GEX44 ssh -L forward, retiring with the dispatcher-owned tunnel.
