# Row 27 - local inference re-measure and bake-off (2026-10-18)

Host: GEX44. Harness: `config/scripts/dws-inference-bakeoff.py` (run on the host). Raw results: `bk-measure.json`, `bk-bakeoff.json` beside this file.

## Re-measure (llama-server :8081, loopback)

- Model id from the server itself: `qwen3-coder-30b` (the only entry; `n_ctx` 32768, 30.5 B params, 18.5 GB gguf). Resident: the process listens on 127.0.0.1:8081 and answered 5/5 streamed requests.
- Decode throughput over N=5: median 48.9 tokens/s (37.8 on the cold first run, 48.3-50.6 after).
- First-token latency, median 0.028 s. Caveat: runs 2-5 reuse the identical prompt, so the server prompt cache makes this a lower bound; the cold run was 1.5 s.

## Bake-off (12 code tasks, machine-checkable asserts, same prompts and scorer)

| Side | Pass | Median latency per task |
|---|---|---|
| local qwen3-coder-30b (temperature 0) | 12/12 | 2.3 s |
| Claude (`claude -p`) | 12/12 | 79.2 s |

- Control: a stub returning `None` for every task fails 12/12 under the scorer (`control` mode), so the scorer can fail an answer. The two 12/12 results are not a scorer that passes everything.
- The set does not separate the two models: both are at the ceiling. It shows the local model is sufficient for short single-function tasks; it says nothing about harder work.
- Claude latency is wall time of a fresh `claude -p` process per task (startup, hooks, network), not model decode time, so it is not a throughput comparison.

## Deviations, stated

- Claude ran as `kobii`, not `orca-svc`: `kobii` has no sudo path to `orca-svc`, and this leg needs no Orca-owned session.
- Claude ran with its default settings; temperature is not controllable through `claude -p`.
