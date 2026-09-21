---
covers: [presentation-cpu-residency, use-tab-agent, terminal-rail, tab-strip, subscriber-fan-out, w3]
status: PLANNED
---

# Presentation derivation is projected once per session, not thirteen times per row

**Status: PLANNED.** Nothing in this document is implemented yet. It becomes the fourth shrink in
[`resource-elasticity-fabric.md`](./resource-elasticity-fabric.md) when the code, its tests and the
measured numbers land together — not before.

## What is being fixed, and what is not

W1 measured the retained JS cost of a dormant terminal row at roughly **55 KB**, across three
GC-forced real-app runs. That is small, and it removed memory as the argument for virtualizing
anything. The cost that survived the measurement is CPU, and it is structural:

- A dormant terminal is presented by exactly one of two mutually exclusive surfaces — the rail row
  (~9 DOM nodes, 24 store subscribers) or the tab strip tab (~13 DOM, 21 subscribers).
- Zustand notifies by iterating its listener Set on **every** `setState`
  (`store/store-listener-census.ts:11-12`), so every one of those subscribers re-runs its selector on
  every store write anywhere in the app.
- At 50 rows that is ~1,050–1,200 selector evaluations per unrelated store write.

**Exactly 13 of the rail's 24 subscribers belong to one hook**, `useTabAgent`
(`renderer/src/lib/use-tab-agent.ts:187-265`). Both surfaces call it — `TerminalRail.tsx:88` and
`tab-bar/SortableTab.tsx:117` — so whichever surface is mounted pays the same 13.

This is **not** a windowing change. Virtualization remains unjustified on the current evidence and is
deferred to its own decision gate (below).

## The unmeasured half: allocation

Two of those 13 selectors allocate on every evaluation:

- `hasRemoteRuntimePty` (`use-tab-agent.ts:257-264`) builds a `Set` and spreads it into an array.
- `focusedPaneKey` (`use-tab-agent.ts:221-224`) mints a string through `makePaneKey`.

So at 50 rows, one unrelated store write allocates on the order of 50 Sets + 50 arrays + 50 strings.
A subscriber count cannot see this, which is why the baseline below counts allocations separately
rather than inferring them from subscriber totals.

## The shape of the fix, and why it is not new

The repository already contains this pattern, working, in the sibling derivation:
`resolveTerminalTabActivityStatus` (`components/tab-bar/terminal-tab-activity-status.ts:38-59`) keys a
module-level cache on the store references it reads, buckets the whole pane-status map by tab once
per snapshot — `O(agents + tabs)` instead of `O(agents * tabs)` — and returns a **primitive**, so a row
re-renders only when its status actually flips.

`useTabAgent` returns `TuiAgent | null`, which is also a primitive. Its 13 reads therefore collapse to
**one** subscription over a snapshot-keyed projection, by extending an owner that already exists.

**No new store. No new source of truth.** The projection is derived, cheap, deterministic and
non-authoritative. It replaces reads; it does not replace the resolvers in `lib/tab-agent.ts`, whose
precedence ladder is unchanged and stays under its existing tests.

### What the projection cannot absorb

`useTabAgent` is not a pure selector. It owns `hasObservedAgentSignal` state and two effects, one of
which calls `clearTabLaunchAgent` (`use-tab-agent.ts:302-334`). Those are per-row and stay per-row.
The projection covers the 13 **reads** only. Any claim that this hook became stateless would be false.

## RED, before any implementation

A characterization of today, which must fail the moment the fix lands and then be inverted in place:

1. At 1/10/50/100 rows, selector evaluations per store write are linear in rows with slope ≈ 24 (rail)
   and ≈ 21 (strip).
2. At 1/10/50/100 rows, `Set` + array + string allocations per store write are linear in rows with a
   non-zero slope.

Both numbers come from the same instrument the existing ratchets use
(`store/store-listener-census.ts`), which returns `null` for unmeasured rather than `0`.

## Acceptance criteria

- Rail subscribers per row: 24 → ~12. Strip: 21 → ~9.
- Allocations per store write attributable to `useTabAgent`: non-zero slope → ~zero slope.
- Existing agent-identity behaviour unchanged: `use-tab-agent*.test.ts` (5 files) stay green with no
  assertion edited.
- The existing ratchets at `terminal-rail-presentation-residency.test.tsx:197` and the strip twin are
  **lowered**, not loosened, so the next growth cannot hide in slack.
- No cost transferred: a single giant object subscription is an explicit non-goal, and the projection
  must still return a primitive per tab.
- Retained JS heap does not materially regress (W1 envelope, ~55 KB/row).

## Measurement protocol

Counts only. This host runs at ~11.7% free RAM, where wall-clock and RSS readings drift further than
the effect being claimed; any timing reported must carry a drift bound smaller than the effect or be
labelled INCONCLUSIVE. 500/1,000-row points are reported as measured or as `RESOURCE_BLOCKED`, never
extrapolated.

Measurements are taken in the lab worktree at the retraction commit `8f9774a91`, never at
`fb3c1bbba`, which predates the correction.

## Production topology control

Rail and strip never coexist, and this is provable rather than merely observed: the rail mounts only
when `activeTab.contentType === 'terminal'` (`tab-group/TabGroupPanel.tsx:404`) **and** the rail is not
collapsed (`terminal-rail/TerminalRail.tsx:243`), while the strip renders terminal tabs unless
`activeTab.contentType === 'terminal' && !terminalRailCollapsed` (`TabGroupPanel.tsx:103`). The strip's
guard is the exact negation of the rail's conjunction, so no product state mounts both.

Any fixture that mounts both is measuring a composition production cannot reach, and its per-row costs
must never be summed. A test asserting this complement is cheaper than a real-app station and cannot
be satisfied by an impossible fixture.

## Windowing decision gate (NOT part of this change)

Virtualizing the rail or the strip is justified only by evidence not yet in hand: interaction latency
at high cardinality, scroll jank, tab-switch latency, or mount cost — measured after this shrink, on a
host with enough headroom to resolve it. Memory is explicitly not an argument for it. When that
evidence exists, the ratchets' predictive linearity check is what fails first, and it is inverted in
place rather than replaced.

## Rollback

The projection is additive and read-only. Reverting the single commit restores the 13 direct reads;
no persisted state, schema or wire format changes, so there is nothing to migrate back.
