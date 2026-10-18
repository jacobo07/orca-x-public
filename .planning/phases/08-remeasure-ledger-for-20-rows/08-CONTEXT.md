# Phase 8 context

Unattended discuss (no Owner available); decisions below are taken from the ROADMAP milestone 2 rules and are reversible.

## Scope
One ledger `docs/dws/remeasure-2026-10-18-ledger.md` for rows 6 16 25 26 28 30 31 32 37 39 40 41 43 47 48 49 50 51 55 75 of `config/dws-completion-matrix.jsonc`. Each row: the `done` text, code/tests/evidence found (paths), tests actually run with counts, one class (MET, MEASURABLE, SMALL-GAP, LARGE-GAP, OUT-OF-PROGRAM).

## Decisions
- D8-1 Read-only sweep first; the only writes are the ledger, the plan files and matrix restatements.
- D8-2 A row is stamped PASS only when a test or leg that ran in this phase meets its whole `done` and the evidence entry resolves to a file in the repo. Code reading alone never stamps.
- D8-3 Every "nothing found" carries the exact search and a positive control (a known-present symbol found by the same search).
- D8-4 Tests run through `node node_modules\vitest\vitest.mjs run <files>` (npx is broken here); one Electron leg at a time and only with free RAM >= 6 GB. Phase 8 runs no live leg; rows needing one are classed MEASURABLE and handed to phases 9-12.
- D8-5 Matrix edits by exact string replacement preserving CRLF; checker must exit 1 (never 2) and its vitest stay green; after any matrix edit re-stamp every phase digest with `verification.fingerprint`.
- D8-6 No product code change in this phase; SMALL-GAP rows are only named.
- D8-7 Push `rb-live:refs/heads/orca-x/dws-rebaseline-live` fast-forward only at phase end, verify with ls-remote.

## Deferred
Building any gap beyond SMALL-GAP; live legs (phases 9-12).