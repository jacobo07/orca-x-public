# Roadmap: DWS remaining live legs (rb-live)

## Overview

Finish the last READY_FOR_LIVE rows of `config/dws-completion-matrix.jsonc` as real laptop -> GEX44 legs,
and restate each row from what was measured. Each phase ends with a committed spec/harness change (if any),
an evidence doc `docs/dws/live-<date>-row-<NN>-evidence.md` (force-added, docs/** is gitignored), the matrix
row restated (PASS only when the row's whole `done` is met; otherwise PARTIAL with the measured part and the
named gap), and a fast-forward push of `rb-live` to `origin orca-x/dws-rebaseline-live`.

## Phases

- [x] **Phase 1: Row 61 paired fan-out** - `orca project setups --all-environments` over two real saved paired environments, one reachable, one with its carrier down
- [x] **Phase 2: Rows 24 and 34 mission-place two-host** - `orca orchestration mission-place` over two real paired hosts with a ready setup hydrated on one; persisted task_placements read back
- [ ] **Phase 3: Row 70 Continue here reattach** - new two-host spec: Continue here from the Working Sets dialog onto a connected remote host, open a restored row, observe reattach to the live remote PTY
- [ ] **Phase 4: Row 65 disk-full and disconnect** - `hwf-two-host-replica-pair.spec.ts -g disk-full-and-disconnect` with ORCA_HWF_SMALL_FS_ROOT on the dedicated 512 MB volume R:

## Phase Details

### Phase 1: Row 61 paired fan-out
**Goal**: Measure the fan-out half of row 61 live: two saved paired environments, the reachable one answered with its replicas, host and role, the downed one unreachable, and the exit never claiming the downed host holds nothing.
**Depends on**: Nothing (first phase)
**Success Criteria** (what must be TRUE):
  1. Two saved environments exist in an isolated e2e userData, each paired to a real `orca serve` on GEX44 (disposable root serve, loopback + SSH tunnel; never the orca-dws-serve unit).
  2. `orca project setups --all-environments` output shows one runtime `answered` with replicas and one `unreachable`, read from the real CLI against the real app.
  3. A control proves the instrument: with both carriers up, both read `answered`.
  4. Matrix row 61 restated with the evidence doc; teardown REMAINING=0 and PROC_COUNT=0; witness unchanged.
**Plans**: 1 plan (01-01), done

### Phase 2: Rows 24 and 34 mission-place two-host
**Goal**: Run `orca orchestration mission-place` over two real paired hosts and read placements back from the app's persisted task_placements; a ready setup of the task project hydrated on one host must be preferred (row 24), and the golden distribution must hold live (row 34).
**Depends on**: Phase 1
**Success Criteria** (what must be TRUE):
  1. Built on the row 72 B harness (`tests/e2e/hwf-two-host-mission-dispatch.spec.ts`, serve-p22 / pairing-p22 verbs), not a new transport.
  2. task_placements rows on two distinct hosts are read back from the app, not recomputed in the Playwright process.
  3. With a ready setup seeded on one host, `locality[].hydrated` is true for it and that host is chosen; a control without the setup does not prefer it.
  4. Rows 24 and 34 restated honestly (row 24 keeps its no-freshness-window caveat); teardown clean.
**Plans**: TBD

### Phase 3: Row 70 Continue here reattach
**Goal**: A committed two-host spec drives Continue here across hosts in the real app against a live remote PTY, and observes a reattach rather than a new PTY.
**Depends on**: Phase 2
**Success Criteria** (what must be TRUE):
  1. A two-host run file seeds the target host; the target host is connected over real SSH (no store-seeded availability).
  2. Continue here from the Working Sets dialog returns a per-pane result; opening a restored row reattaches to the live remote PTY (same remote pid, no new PTY), measured on GEX44.
  3. A negative control (target disconnected) refuses and applies nothing.
  4. Matrix row 70 restated; teardown clean.
**Plans**: TBD

### Phase 4: Row 65 disk-full and disconnect
**Goal**: Run the disk-full-and-disconnect leg on the dedicated tiny local volume and restate row 65.
**Depends on**: Phase 3
**Success Criteria** (what must be TRUE):
  1. R:\ exists, is at most 1 GiB, and is not the C: device (spec asserts both); if R:\ is absent, stop with `HUMAN GATE: Owner must mount the small VHD (see STATE.md)` and do not fake a filesystem.
  2. Normal clone: "synced a..b", HEAD equals remote tip. Full volume: "the local disk is full; HEAD was not moved", exit 1, HEAD unchanged. Carrier dropped: "the connection to the host was lost", exit 1, HEAD unchanged.
  3. The filler is removed afterwards; matrix row 65 restated; teardown clean.
**Plans**: TBD
