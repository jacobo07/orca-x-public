# Phase 1: Reality close — rows, owners, slices

Measured 2026-10-26 on this laptop at HEAD aa427e52b.

## DWS verifier
`node config/scripts/check-dws-completeness.mjs` -> exit 1, "48 of 76 required row(s) PASS (ABSENT=10
PARTIAL=18 PASS=48)", "Verdict: CONTRACT INVALID". Matches STATE.

## Full reasons (verbatim from config/dws-completion-matrix.jsonc)

**Row 12 Mobile projection** (PARTIAL, matrix line 402):
> 2026-10-19 (Owner chose defer to spec order): the uwcp.control/1 verbs alone do NOT unblock this row; mobile reach needs a per-Workstream scope beyond the allowlist. Blocker restated: UWCP stages after S4-22 (S4-23 placement, S5 broker, step 35 forced-command verbs, step 44 contract). BLOCKED_EXTERNAL: UWCP-control-verbs — re-measured 2026-10-15 on dws/rebaseline @a3e7239a51db (dwsrb phase 1): control-verbs=ABSENT: 0 hits across 1266 tracked mobile files (control: pairing hits exist), workstream.cancel is desktop-only by design (config/mobile-capability-aperture-baseline.txt:329-331), and a mobile read of Workstream state needs the rows 1/2 runtime source first, so no mobile surface is buildable ahead of the Operator Event consumer.; measured=`git grep -n -i -E 'operator.?event|workstream' -- mobile ':!*.test.ts'`. Prior (stage-zero-seed): Stage Zero: PARTIAL — mobile reads state + sends one Operator Event not yet evidenced

**Row 33 Host switching** (PARTIAL, line 1185):
> 2026-10-19 (Owner chose defer to spec order): the uwcp.control/1 verbs alone do NOT unblock this row. MIS-LISTED: it depends on Phases 2-11 and epoch node/home fields, not the control verbs. Blocker restated: UWCP stages after S4-22 (S4-23 placement, S5 broker, step 35 forced-command verbs, step 44 contract). BLOCKED_EXTERNAL: UWCP-control-verbs — re-measured 2026-10-15 on dws/rebaseline @a3e7239a51db (dwsrb phase 1): control-verbs=ABSENT: 0 hits in the host-translation module (it exists, grep exit 1) and the only src/main/runtime hits are the refusing Cancel, so no Workstream identity crosses a host move; "same Workstream, different host" needs the row 5 identity and the UWCP epoch node/authority_home fields (vault/specs/uwcp.md:68), the host half is Orca's but cannot be judged without them.; measured=`grep -n -i workstream src/shared/project-working-set-host-translation.ts`. Prior (stage-zero-seed): Stage Zero: PARTIAL — same Workstream, different host not yet evidenced

**Row 39 Multi-client consistency** (ABSENT, line 1408):
> phase 12 re-measure 2026-10-18: OUT-OF-PROGRAM. Stale-write refusal rests on UWCP log ordering plus the control verbs, which Orca cannot supply (see rows 1 2 4). Unchanged ABSENT.

**Row 75 HF Real two-host Production Reality** (PARTIAL, line 3494), closing sentence:
> Phase 11 re-measure 2026-10-18 (docs/dws/remeasure-2026-10-18-hf-cross-host-enumeration.md): that owed list is stale; every HF row 59-74 now has a two-host spec and is PASS, but rows 64 and 66 are exercised live only in part (creation leg; primitive), so this row stays PARTIAL.
(Full text: matrix line 3494; it lists runs 1-3 of phase 15, run 6 of phase 16 and the phase 20 roots.)

## Canonical owners (grep-backed)
| Concern | Host-side owner | Mobile owner / caller |
|---|---|---|
| Host selection | per-host connection (no host field in terminal.send) | `mobile/src/transport/host-store.ts`, `host-picker-options.ts:6 hostPickerOptions`, `mobile/src/session/mobile-session-host-options.ts:6 switchHostPickerOptions`, `MobileSessionHostPicker.tsx` |
| Runtime selection | `terminal.list` (terminal.ts:1141) | `mobile/src/session/mobile-session-runtime-actions.ts:15 resolveActiveTabRuntime`, `:30 buildMobileSessionRuntimeActions` |
| Terminal input | `terminal.send` terminal.ts:1227 (stale handle via `resolveLiveLeafForHandle`, per-client lock `isTerminalInputLockedForClient`) | `mobile/app/h/[hostId]/session/[worktreeId].tsx` lines 3008, 3069, 3303, 3858; `mobile/src/terminal/terminal-live-accessory-raw-send.ts` |
| Terminal read (oracle input) | `terminal.read` terminal.ts:1183 -> `OrcaRuntime.readTerminal` orca-runtime.ts:17974, shape `RuntimeTerminalRead` runtime-types.ts:604 (`latestCursor`, `truncated`) | — |
| Agent turns | `terminal.ensureAgentSession` / `terminal.createAgentSession` agent-session.ts:237/248; `agentPrompt` flag on terminal.send | `mobile/src/session/ai-vault-resume-materialization.ts:187`; `[worktreeId].tsx:3803` passes `agentPrompt` |

Commands: `git grep` / ripgrep over `src/main/runtime/rpc/methods`, `mobile/src`, `mobile/app`.

## Mobile slices 1-4 intact
`git log -- mobile`: 8789398f4 (slice 1), aa67c8a2b + e886e1460 (slice 2), 04349118c + 6e4a36d74 (slice 3), 330b96941 (slice 4), all ancestors of HEAD.

## Absence of a fresh-output proof (with positive control)
`git grep -i -E "fresh.?output|freshOutput" -- src tests mobile/src` returns 8 hits (the search can see
the phrase), all daemon/IPC delivery tests; none sends from a paired client and judges a nonce after a
marker. So the proof is absent, not unseen.
