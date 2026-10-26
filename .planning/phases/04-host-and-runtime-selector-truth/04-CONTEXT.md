# Phase 4: Host and runtime selector truth - Context

**Gathered:** 2026-10-26
**Status:** Ready for planning
**Mode:** Autonomous smart-discuss (unattended; recommended option taken)

<domain>
## Phase Boundary
Every host and runtime the phone shows has a real producer; switching host A to B shows none of A's
rows and mutates nothing on A; never-connected reads as not connected, never as offline or failed;
listing hosts opens no background socket.
</domain>

<decisions>
## Implementation Decisions
- D-01 Producers (read, not rebuilt): host rows = `HostProfile` store + `switchHostPickerOptions`;
  host states = `useAllHostClients` in observe-only mode (`autoConnectHostIds: []`); runtime rows =
  `buildMobileSessionRuntimeActions` over the host's agent rows; worktree rows = `WorktreeCatalogSnapshotClient`
  + `worktree-cache` keyed by hostId.
- D-02 Proof is a sequence test of the home screen's real data path (catalog + cache) through an A->B
  switch with A answering late, plus the existing picker/options tests, run where mobile deps exist.
- D-03 Mobile deps are not installed on the laptop (RAM law); mobile tests run on GEX44 in a disposable
  /tmp/orca-phone-p4-* root, torn down after.
- Finding (no change made): the `hostId !== requestHostId` checks in mobile/app/h/[hostId]/index.tsx
  (fetchRepoMetadata, fetchWorktrees) compare two values from the same closure and are dead; the live
  guard is `clientRef.current !== requestClient` plus the catalog client's own host check. Left as is:
  removing them is cosmetic and the catalog mutant proves the real guard.
</decisions>
