# Live two-host legs 2026-10-15: rows 60 and 63

## Plane

REAL-TWO-HOST. The Electron app built in a laptop worktree, driven by Playwright through `orcaPage`,
connected over real SSH to a disposable root on GEX44 (`/tmp/orca-hwf-p17-*`). Witness unchanged and
teardown `PROC_COUNT=0` after the run.

## Source of the lines below

The run log stayed on the laptop. GEX44 holds no copy (searched `/home/kobii/missions` and `/tmp` on
2026-10-15 for `HWF63_COMPARE_LIVE` and `HWF60_PIN`: no file). The values are copied from the commit
messages written at the run, and from `docs/dws/rebaseline-handoff-backlog.md`:

- `b6bf94d37`: row 63 leg. `HWF63_COMPARE_LIVE PASS "diverged +1/-2" exit 0`;
  `HWF63_COMPARE_DOWN PASS "unverified (host-unreachable)" exit 1`; `1 passed`.
- `8f95517ee`: the provisioner fix that let any two-host leg reach `create` from Windows; create, seed,
  run-file and teardown verified live against GEX44.
- Backlog table: row 60 grouped-relation leg PASS (transport and remote ahead 2).

## Command

```
npx playwright test tests/e2e/hwf-two-host-replica-pair.spec.ts --config tests/playwright.config.ts \
  --project=electron-headless -g relay-compare-result
```

with `SKIP_BUILD=1`, `ORCA_HWF_TWO_HOST=1`, `ORCA_HWF_RUN_FILE`, `ORCA_HWF_P17_PATH` (from `seed-p17`)
and `ORCA_HWF_LOCAL_PORT`.

## What the passing leg observed

`relay-compare-result` passes only when every step below holds (`tests/e2e/hwf-two-host-replica-pair.spec.ts:242-319`):

1. The SSH target connects with the pin equal to the run fingerprint, and the remote replica is two
   commits past the seed root (`HWF63_REMOTE_AHEAD=2`, read on GEX44 with git).
2. A local replica made by `seed-local-p16` (`git init`, no remote, seed commit plus one host commit)
   and the remote replica at `ORCA_HWF_P17_PATH` group into one Project by root identity
   (`waitForRootGrouping` on the seed root).
3. `orca project replica-compare --project <id>` prints `diverged +1/-2` for the SSH setup and exits 0.
   The expected word is derived from both measured sides, so this is not an assumed relation. The
   comparison runs through the pair service and `compareWithSshRelayReplica`: capability probe,
   bundle export, sha256-checked chunked pull, `bundle verify`, fetch, ancestry on the received objects.
4. With the carrier killed and the renderer no longer connected, the same command prints
   `unverified (host-unreachable)` and exits 1.

## Rows

- Row 63 (cross-host comparison transport): steps 3 and 4 are the relay-compare result the row lacked.
  The transport precondition already ran live on 2026-10-14 (X08).
- Row 60 (remote-less identity): step 2 is a remote-less repo on two hosts deriving one Project in the
  app, and step 3 is a diverged pair staying grouped with its relation surfaced, not merged.

## Not covered

- The rendered Settings relation row (row 62, LOCAL_RENDER): nothing here read the UI.
- The anchor setup of a pair still reads unverified (phase 2 risk, unchanged).
- Same-host fork collision records were observed in phase 16 Run 6, not in this run.
- No raw log in the repo; the claims rest on the commit messages above.
