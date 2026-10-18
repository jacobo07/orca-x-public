# Model residency drill (row 26), 2026-10-18

Question: does Orca treat "a model is available on a node" as different from "a model is loaded and answering"?

## Live reading (GEX44, read-only, 2026-10-18)

- `/opt/keos-llm/bin/llama-server -m /opt/keos-llm/models/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf --alias qwen3-coder-30b --host 127.0.0.1 --port 8081 -c 32768 --jinja -t 20 -ngl 99` (pid 919540).
- `GET :8081/v1/models` lists `qwen3-coder-30b` only.
- On disk but not loaded: `/opt/keos-llm/models/Qwen3-Coder-Next-IQ4_XS.gguf`.

So two models are available on the node and one is resident.

## Judging (unit-level replay of that reading)

`src/shared/node-manifest-eligibility.test.ts`, `describe('available is not resident')`, 14/14 passed:

- requirement `qwen3-coder-30b` (resident) is `eligible`; `qwen3-coder-next` (on disk) is `ineligible` with `model-not-resident`.
- the same absence while a probed port did not answer is `unknown`, never `ineligible` (absent is not a definite no).

The test replays the recorded reading; it does not call GEX44.

## Mutants (both red, restored green)

1. unanswered ports no longer force `unknown`: the unanswered-port test fails ("expected 'ineligible' to be 'unknown'").
2. residency check replaced by `true` (any listed id counts): 3 tests fail.

## Residual

The judge is not yet wired to a live routing decision on the paired host; this row evidences the rule, not an end-to-end placement.
