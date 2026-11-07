# 20 UKDL proposal (PROPOSAL, not applied)

**Status: PROPOSAL.** Nothing in this file has been written to the Power Pack UKDL. The shared file
`C:\Users\<owner>\.claude\skills\claude-power-pack\vault\knowledge_base\ukdl-universal.md` was read only, for the
entry format and a collision check. Applying it is the Owner's act, in the Power Pack checkout: append the section
below to `ukdl-universal.md` and commit it there. This worktree never writes to that checkout (orchestrator
decision 5, D-11).

Read-only evidence (2026-10-28, this laptop):
- `ukdl-universal.md` sha256 before this plan: `468CA6543674278D5E92922A133BAE1FCF189813C503BCB1E75CAEC7CF5C9D46`
  (13187 lines). The after-hash is recorded in `20-05-SUMMARY.md`.
- Entry shape copied from the file: `### <PREFIX>-<SLUG>-001`, then one paragraph with the trigger, the action
  and the origin (for example `### T-LIVE-LOG-IS-NOT-LIVE-PRODUCER-001`, near line 259).

Collision check (`Select-String -SimpleMatch` on `ukdl-universal.md`, each id and its core slug):

| Proposed id | Full-id hits | Core-slug hits | Result |
|---|---|---|---|
| T-WAKE-PACKET-SENT-IS-NOT-A-HOST-WOKEN-001 | 0 | `WAKE-PACKET` 0 | no collision |
| HR-UNREADABLE-REGISTRY-IS-UNKNOWN-NEVER-PRESENT-001 | 0 | `UNREADABLE-REGISTRY` 0 | no collision |
| T-LINT-STAGED-STALE-INDEX-001 | 0 | `LINT-STAGED` 0 | no collision |
| PR-RELAY-IS-PROVENANCE-NOT-IDENTITY-001 | 0 | `RELAY-IS-PROVENANCE` 0 | no collision |
| T-UPPERCASE-WIRE-REASON-PARSES-UNSPECIFIED-001 | 0 | `UPPERCASE-WIRE` 0 | no collision |

---

## Host availability (Orca X phases 17-20, 2026-10-27)

### T-WAKE-PACKET-SENT-IS-NOT-A-HOST-WOKEN-001

A wake packet sent is not a host woken. Trigger: any component that sends a wake, power-on or resume command and
then reports state. Action: the sender records at most its own send (`requested`, `authorized`, `packet-sent`,
`packet-send-failed`); "the host is up" comes only from the target's own answer after the send, and "usable" only
from its runtime and fresh output. Pin the sender's writable stages and keep a mutant that writes the target's
stage. Origin: Orca X phase 19, mutant P19-M3 (`packet-sent` recorded as `host-announced`), caught only by the
stage-law test; `docs/reference/host-wake-broker.md` on branch `mobile/host-availability`.

### HR-UNREADABLE-REGISTRY-IS-UNKNOWN-NEVER-PRESENT-001

An authority that cannot be read is unknown, never present. Trigger: an effect gated on a registry, list or file
of who may act (paired devices, grants, consent). Action: STOP if the check is two-valued; it must be
present/absent/unknown, unknown refuses the effect, and unknown never deletes the state that absent would delete
(grants stay until the registry can say the device is gone). Exception: none. Origin: Orca X phase 19 review
WR-01, where the wake device check read an unavailable registry as present (fixed cab270fb0, b88f111c5).

### T-LINT-STAGED-STALE-INDEX-001

lint-staged can leave a stale index after a successful commit: the formatter rewrites the staged files, the commit
records them, and the index ends up differing from both HEAD and the tree. Trigger: any commit in a repo with a
formatting pre-commit hook. Action: after every commit run `git diff --cached --quiet` and
`git diff HEAD --ignore-cr-at-eol --quiet -- <files>`; reset index entries only when the tree equals HEAD, and
restore line-ending-only dirty files from HEAD. Never `git stash`. Origin: Orca X phases 19-20 (3 of 6 commits in
20-02, 3 of 4 in 20-03).

### PR-RELAY-IS-PROVENANCE-NOT-IDENTITY-001

The relay is provenance, never identity, and transport independence is proven, not inferred. Trigger: an effect
reachable both direct and through a relay or proxy. Action: key authority by the subject (the paired device), and
prove the relayed path by driving real frames through the real transport and server wiring, with a mutant on each
check (authority at the effect, relay device binding); "there is no relay branch" is an argument, not evidence.
Origin: Orca X phase 20, `src/main/runtime/wake-broker-relay-dispatch.test.ts`, mutants P20-L1 and P20-L2.

### T-UPPERCASE-WIRE-REASON-PARSES-UNSPECIFIED-001

An uppercase verification label is not a wire reason. Trigger: choosing a reason string for a capability or
refusal that a client parses. Action: read the parser's reason pattern first (Orca X: `^[a-z0-9_]{1,64}$`); a
label such as `HARDWARE_BOUND` sent as a reason reaches the client as `unspecified`. Keep labels in verification
text and send a lowercase reason (`hardware_bound_amd_no_amt`). Origin: Orca X phase 20 research pitfall 1,
`src/shared/host-availability.ts` reason parser.
