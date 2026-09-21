---
covers: [presentation-cpu-residency, use-tab-agent, terminal-rail, tab-strip, subscriber-fan-out, w3]
status: LIVE
---

# Presentation derivation is projected once per session, not thirteen times per row

**Status: LIVE.** Implemented in [`src/renderer/src/lib/tab-agent-projection.ts`](../../src/renderer/src/lib/tab-agent-projection.ts),
consumed by `lib/use-tab-agent.ts`, measured by
`components/terminal-rail/terminal-rail-derivation-fanout.test.tsx` and ratcheted by both
presentation-residency files.

Measured, 1/10/50/100 dormant rows, happy-dom:

| | before | after |
|---|---|---|
| rail subscribers per row | 24 | **13** |
| strip subscribers per tab | 21 | **10** |
| resolver calls per row, unrelated write | 6 | **0** |
| pane-key strings per row, unrelated write | 4 | **0** |
| resolver calls per row, write that moves the inputs | 6 | **6** |
| pane-key strings per row, write that moves the inputs | 4 | **4** |

The last two rows are the point: necessary derivation is unchanged, and only repeated derivation was
removed. They are also the control — a zero in the rows above is produced equally by a working
projection, a mock that failed to bind, and a projection that stopped deriving anything, and only a
non-zero measurement in the same run tells them apart.

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

## Acceptance criteria, and what was measured

- Rail subscribers per row 24 → **13**, strip 21 → **10**. The estimate written before the work said
  ~12 and ~9; it was one out on each, because `useTabAgent` keeps two subscriptions rather than one —
  the projection, plus the stable `clearTabLaunchAgent` reference its exit effect needs.
- Allocations per unrelated store write: **zero at every scale**, not merely a zero slope. A
  slope-only assertion would let a constant per-write cost hide in the intercept.
- Agent identity unchanged: **499 tests green** across the five `use-tab-agent*` files, `tab-agent`,
  and the whole `terminal-rail` and `tab-bar` trees, **with no assertion edited**.
- Both ratchets **lowered**, not loosened. The strip's was *added*: that file previously asserted only
  integrality and linearity, so it passed through a 21 → 10 change without noticing either number.
- No cost transferred. The projection is not one giant object subscription: it returns a per-tab entry
  whose reference is reused while its fields are unchanged, so a change to one tab still re-renders
  exactly one row.

### What this does NOT claim

`useTabAgent` did not become stateless. It still owns `hasObservedAgentSignal` and two effects, one of
which clears a stale launch agent; those are per-row and stayed per-row. The projection replaced the
thirteen **reads** only.

Retained JS heap was **not** re-measured. The W1 envelope (~55 KB/row) is a real-app GC-forced figure
and this host sits near 11% free RAM, so a heap claim made here would carry drift larger than the
effect. Removing allocations while lowering subscriber counts makes a regression implausible — but
implausible is not measured, and this line says so rather than implying otherwise.

Nothing here has run in the real app. Every number above is happy-dom.

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
