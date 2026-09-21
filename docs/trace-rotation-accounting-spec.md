# Trace Rotation Accounting — Spec of Record

Status: active · Owner: `src/main/observability/local-file-sink.ts` · Tier: T2

## Problem

`rotate()` resets the byte counter unconditionally. Every failure inside the rename
cascade is swallowed (`local-file-sink.ts:123-125`), `rotate()` returns no status, and
nothing between the cascade and the reset checks whether anything actually moved:

- line 128 reopens `filePath` in append mode — the *same* file if the rename failed
- line 129 sets `currentBytes = 0` regardless

When the base-file rename fails — a Windows sharing violation, an AV scanner holding the
handle, a second Orca instance with its own append fd on the same path, a read-only volume
— the sink reopens a still-full file and tells its own accounting the file is empty. The
rotation check at line 183 then cannot fire again until another full `maxBytes` has been
counted, so the live trace grows to ~2× the cap, and to ~N× after N consecutive failures.

This is the general defect: **state tracking a committed side effect must not advance as
though the side effect succeeded.**

## Scope

In: the byte-accounting reset in `rotate()`, and bounding the retry it implies.
Out: the rename cascade's swallow-and-continue policy (partial rotation really is
preferable to crashing the trace lane); the health/reporting surface, which is a separate
unit of work; anything in the tracer or the breadcrumb writers.

## Contract

1. After a rotation attempt, `currentBytes` equals the true size of the file the sink now
   holds open. It is derived from the reopened descriptor, never assumed.
2. A rotation that did not reduce the file cannot be reported to the accounting as one
   that did.
3. A permanently failing rename must not cause a per-line rotation storm. At most one
   rotation attempt per flush pass.
4. Writes continue to land while rotation is failing. Losing the trace lane is a worse
   outcome than exceeding the cap; the lane degrades, it does not stop.
5. Successful rotation is unchanged: the fresh base file starts at zero and the cascade
   still walks highest index down.

## Acceptance

- RED — self-healing. With the cascade's destination made un-renameable by real filesystem
  semantics (no mocks, no monkey-patched `fs`), write past the cap so a rotation is
  attempted and fails; then clear the obstruction and write one more small record. The
  sink must rotate on that next write. Under the defect it cannot: the reset told it the
  over-cap file was empty, so it waits for another full `maxBytes` before trying again.

  Note this is deliberately *not* an assertion that the family stays bounded while the
  rename keeps failing. It cannot be, and claiming otherwise would be a contract the code
  must break: contract 4 says writes keep landing, and a file that cannot be rotated and
  must still be written to necessarily grows. Bounded-during-permanent-failure and
  keep-writing are contradictory; self-healing is the property that actually distinguishes
  truthful accounting from the defect.
- Negative control: ordinary rotation with a writable destination still rotates, still
  produces `.1`, and still starts the base file from zero.
- Mutation: restoring `currentBytes = 0` turns the RED red again. Restore verified.
- No new attributable red in the observability suite.

## Rollback

Single-function change in one module. Reverting the commit restores prior behaviour
exactly; no persisted state, schema or wire format is involved.

## Non-goals worth stating

This does not make the trace lane failure-*aware*. Nothing yet distinguishes "no events
occurred" from "the sink could not record them" — the sink still swallows, it just stops
lying about the byte count. That gap is real and is tracked separately.
