# Node manifest handoff to UWCP

Status: emit half LIVE (Orca produces and validates manifests); consume half BLOCKED (see the last section).

## Contract

- Schema file: `config/schemas/orca-node-manifest-1.schema.json` (`$id` `urn:orca:schema:node-manifest:1`).
- Version const: `orca.node-manifest/1`. A consumer refuses a version it does not know; it never guesses.
- UWCP imports the schema file. Orca never writes into the Claude Power Pack tree.

## Field semantics

- `measured_at` is epoch milliseconds on the OBSERVER's clock. A node-supplied time never enters a manifest.
- `max_age_ms` is the trust window for that measurement. Defaults: memory 60 s, vram 60 s, resident model 300 s, disk 600 s.
- An `unknown` measurement carries a `reason` and no numbers. Unknown is not zero.
- `known_heads`: absent means unknown; `[]` is invalid and is never emitted.
- `node.fingerprint` (null when the node is unkeyed) is the dedupe key: one manifest per observed member.
- `node.capabilities` null means the host did not say, which is not "has none".

## Freshness rule

The only age check is `src/shared/node-measurement-age.ts`; eligibility is `judgeNodeEligibility` in `src/shared/node-manifest-eligibility.ts`. A sweep test (`src/shared/node-measurement-age-sole-authority.test.ts`) fails if any other fleet module subtracts or compares a measurement age.

## Obtaining manifests

- CLI: `orca fleet manifest --json` (optional `--model-probe-ports <p1,p2,...>`, at most 4 ports).
- RPC: `fleet.nodeManifests`, answered to local callers only; a remote caller gets `refused`. Hosts answer `fleet.nodeResources`.
- SSH targets are not enumerated.

## BLOCKED: the consumer half

The consumer, `goal/node.py` (UWCP plan S4 step 22; spec line 74: "node manifest | KSR capabilities.json | EXTEND via goal/node.py adapter (measured_at, known heads, max age)"), does not exist in CPP as of 2026-09-30. The "UWCP adapter consumes it" half of DWS-P5-SC1 is therefore unmeasured and BLOCKED on UWCP S4-22. Completion matrix row 17 stays PARTIAL for that reason.
