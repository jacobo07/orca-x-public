# Phase 7 - federation gates re-measured on GEX44

Verdict: MEASURED.
Gated sha S (gatesFencedSha): 997b4a55a92f860df1e923616b46b0e338448c24. Serve deployed sha (serveDeployedSha): 3266e1a41790ab356def108aca96895e1e921279; the serve was deliberately not redeployed, so these differ.
Federation head (attribution fence): 71dd7bc979858f58633f3a72c081892759f0ee4e.

| fence | sha | remote rev-parse | vitest | other |
|---|---|---|---|---|
| attribution | 71dd7bc979858f58633f3a72c081892759f0ee4e | 71dd7bc979858f58633f3a72c081892759f0ee4e | total 687, passed 677, failed 0, skipped 10 | tsc errors 0, files 95 |
| head | 997b4a55a92f860df1e923616b46b0e338448c24 | 997b4a55a92f860df1e923616b46b0e338448c24 | total 687, passed 677, failed 0, skipped 10 | tsc errors 0, files 95 |

## Red attribution
Pre-existing red (also red at the attribution fence):
- none

Head-only red (FAIL):
- none

## Skipped, not passed
Reality tests are skipped with the provider variable unset and are never counted as passed. Skipped files: agent-delegation-reality.test.ts, agent-task-reality.test.ts, claude-conversation-reality.test.ts, claude-mcp-bridge-reality.test.ts, conversation-process-boundary.test.ts, conversation-reality.test.ts, review-reality.test.ts.

## Clone state at end
cloneHeadAtEnd 997b4a55a92f860df1e923616b46b0e338448c24, orcaXHeadAtEnd f9a721fda491096b74f0115d78632356e526d096.

## NOT-RERUN
- federation's mutation drills: federation's own claim, not re-run because they edit federation-owned files
- tests/e2e/agent-federation-approval.spec.ts: NOT-RERUN, federation P6 evidence ddc6f67d8

## Correction
Federation cites live-review commit 2e8c5516a, which is not present in the object store; da3ec43c0 and 47558af87 are the cited evidence.

## Named debt
- orchestration.reviewRequest, orchestration.reviewShow, conversations.subscribe and conversations.unsubscribe are unfixed mobile-aperture entries: federation debt, not fixed here
- ND-1: the legal lane is the Orca bundle+ssh evidence lane until UWCP S5 dispatcher lands

## Evidence commit boundary
Gates ran at the fenced sha S; the evidence commit E may touch only docs/dws/, the requirements matrix and the allow-list.
