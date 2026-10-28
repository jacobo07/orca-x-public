# Row 17 (GEX44 Node Manifest) -- laptop ssh -L tunnel leg + UWCP S4-22, 2026-10-18

Row 17 owed two things: the laptop-to-GEX44 transport (an isolated laptop Orca paired to the GEX44 serve
over an `ssh -L` tunnel, answering `orca fleet manifest` itself) and the UWCP consumer (S4-22). Both are
now measured.

## Tunnel leg (rung `fan-out`)
- Worktree `C:\Users\User\Apps\orca-p5-ft2-wt`, detached `79f54d64af`: `src` and `pnpm-lock.yaml` are
  identical to the deployed `3266e1a`, so the runner skipped the deploy (`-FanOut` never deploys).
  Own `node_modules` (pnpm install; `windows-native-registry` native.node copied from a working
  checkout, the laptop has no Visual Studio), Git on the Playwright child PATH.
- Command: `powershell -File config\scripts\dws-node-manifest-run.ps1 -FanOut`.
- Run 1 (16:23Z): memory, vram, resident_model MATCH; disk UNJUDGED `control-unstable` (the independent
  ssh control saw GEX44 disk move 3.1 GB during the run, tolerance 1 GB). Not a product verdict.
- Run 2 (16:26Z-16:28Z): **4/4 MATCH** against the ssh control: memory, vram, disk (control drift 12 MB),
  resident_model `qwen3-coder-30b` on probe port 8081. Artifact sha256 8ef4ce12... equal on both ends,
  `runtimeIdMatchesServe: true`, serve MainPID 3357463 before and after, serve stays active.
  Teardown: tunnel ssh processes 0, tunnel listeners 0, laptop e2e Electron 0, no leftover userData.
- Evidence: `docs/dws/live-2026-10-18-row-17-tunnel-fanout.json` (run 2, byte copy, sha256
  CD75A84A764B2B9C...). Laptop copies of both runs: `C:\Users\User\Apps\rbl\d4-ev-r17t1-20261018-1825`,
  `C:\Users\User\Apps\rbl\d4-ev-r17t2-20261018-1828`. No pairing secret in either.

## Consumer (UWCP S4-22)
- Claude Power Pack branch `dws/pp-rows` (pushed): spec `vault/specs/uwcp-s4-22-node-adapter.md` (5c57f4a4)
  and `modules/gsd_x/goal/node.py` + `tools/test_gsd_x_goal_node.py` (8b776241, 465c6126).
- The adapter reads `orca.node-manifest/1` and refuses (never repairs) malformed, stale, future-dated or
  over-age manifests; `known_heads` follows `config/schemas/orca-node-manifest-1.schema.json` (absent =
  unknown, non-empty list of non-empty strings). GSDX_NODE 23/23 against the real producer manifest;
  mutants red. Owner decision 2026-10-18: orca.node-manifest/1 supersedes KSR capabilities.json.

## What this does not prove
The user's own desktop profile, a non-loopback pairing, and a `known_heads` value emitted by Orca
(Orca never emits the field today; the adapter's present case is the real manifest plus the field).
