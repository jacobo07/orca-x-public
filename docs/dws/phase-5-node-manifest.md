# Phase 5 - GEX44 node manifest measurement

Verdict: MEASURED at rung `fan-out-gex44` on 2026-10-14T20:49:42Z .. 2026-10-14T20:50:15Z, HEAD 79f54d64af040e9a4327ca3bd9b645b6cfcda478.
Artifact sha256 (laptop == GEX44): 8ef4ce12f2579e85e3861cea5cde8dd977a74089b1a34feb19f6b30445ac4594. runtimeIdMatchesServe: true.

| family | verdict | reason | product value | plane tag |
|---|---|---|---|---|
| memory | MATCH |  | 59193368576 | GEX44-PROVEN |
| vram | MATCH |  | 3245342720 | GEX44-PROVEN |
| disk | MATCH |  | 903119962112 | GEX44-PROVEN |
| resident_model | MATCH |  | qwen3-coder-30b | GEX44-PROVEN |

Each value was read by the product (a second, isolated Orca runtime on GEX44 paired to the serve over loopback, answering `orca fleet manifest` itself) and independently by an ssh control (free, nvidia-smi, df, curl /v1/models), judged with tolerances:
- memoryAvailableFraction = 0.1: available memory drifts with page cache between two readings seconds apart
- memoryAvailableMinBytes = 536870912: floor for the fractional tolerance so a small host is not held to a few MiB
- vramFreeBytes = 268435456: two other tenants (llama-server, ComfyUI) allocate on the same GPU
- diskAvailableBytes = 1073741824: a 99%-full shared filesystem moves by hundreds of MiB per minute
- modelIds = exact-set-equality: a model id is either served or it is not

Probe port 8081 came from the control run's loopback listener list, not from a code default.
Disk fact for planners: 841.22 GiB available, 49% used on `/` at the control reading.

## Rung and what it does not prove
Rung `fan-out-gex44` is a separate runtime observing gex44-svc through callEnvironment (fleet.nodeResources on the paired serve), hosted on GEX44 because the laptop had too little free memory. It does NOT prove the laptop-to-GEX44 transport (ssh -L tunnel), the user's own desktop profile, or the UWCP goal/node.py consumer (S4-22). a second, isolated e2e Orca on GEX44 (HEAD 79f54d64af, src equal to deployed 3266e1a) paired to the serve over loopback; manifest members: local + runtime:<serve env>.

## Named debt
- ND-1: the legal lane is the Orca bundle+ssh evidence lane until UWCP S5's dispatcher lands.
- ND-2: the laptop-to-GEX44 ssh -L forward, retiring with the dispatcher-owned tunnel.
