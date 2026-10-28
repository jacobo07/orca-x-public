# 21-06 mutant drills: P21-R1, S1, S2, W1, B1, B2, A1

Run 2026-10-28 on the real tree `C:\owx-haf` at `e30eb1230` (branch `mobile/host-availability`), laptop catchers as
single files and mobile catchers on GEX44 disposable roots through the phase 18 runner. These are unit, render and gate
drills (labels UNIT laptop, UNIT GEX44, GATE, MUTANT). None of them is phone evidence.

## Protocol (20-04-MUTANTS.md, restore by byte copy)

Driver `h06-drill.ps1` plus the drill table `h06-drills.ps1`, both in the job tmp directory
`C:\Users\Jacobo\.claude\jobs\fd0cc958\tmp\`, never in the repo. One drill per invocation:

1. `git diff --quiet -- src config mobile` exit 0 and `git diff --quiet -- <target>` exit 0; the target's bytes are
   copied to the tmp directory and their sha256 recorded.
2. The anchor's full text occurs exactly once (ordinal `IndexOf` count 1). A multi-line anchor is written with the
   file's own newline (CRLF or LF, detected per file).
3. Plant by that single replacement (same encoding, BOM preserved if present). PLANT_CONFIRMED means
   `git diff --name-only` names only that file, the plant is present and the diff stat matches the plant.
4. Catchers: `pnpm.cmd exec vitest run --config config/vitest.config.ts <file>`, `pnpm.cmd run check:host-card-claims`,
   or the 18 runner in test mode with the planted file in `-Sync` (it ships working-tree bytes to a fresh
   `/tmp/orca-phone-p18-<ts>` root on GEX44 and proves the root absent afterwards). CAUGHT means every named catcher
   exits non-zero with the expected row or gate line.
5. Restore in a `finally` block by copying the saved bytes back (not `git checkout`). RESTORE_VERIFIED means the
   sha256 equals the pre-plant hash, `git diff --quiet -- <file>` exits 0, every laptop catcher exits 0 again and
   `git diff --quiet -- src config mobile` exits 0. The GEX44 catchers of P21-W1 and P21-B1 are re-run once together,
   after both restores, as their shared RESTORE_VERIFIED run.

## Drills

| Mutant | Plant (file: exact current anchor -> plant) | PLANT_CONFIRMED | CAUGHT (command, exit, decisive line) | RESTORE_VERIFIED |
|---|---|---|---|---|
| P21-R1 Wake classified with a non-existent rpc (D-09 b) | `config/host-card-claims.jsonc:277` (CRLF, no BOM), host-card-wake action: `"rpc": "host.wake.request",` -> `"rpc": "host.wake.go",` | yes: anchor text hits 1; `git diff --name-only` = `config/host-card-claims.jsonc` only; `1 file changed, 1 insertion(+), 1 deletion(-)` | CAUGHT: `pnpm.cmd run check:host-card-claims` exit 1, `check-host-card-claims: 4 problem(s)`, `- action "host-card-wake": rpc "host.wake.go" is not a host RPC method — an effect with no backend`, and the scope rule then refuses the control's own wording: `- mobile/src/components/MobileHostCard.tsx:179 effect wording "host-card-wake" but no effect control classified to a host RPC method encloses it` (also :181 `Wake ${props.host.name}` and :189 `Wake`) | RESTORE_VERIFIED: sha256 `E39BE9ED26C49C94ED188577AC4D43FD3C04D0C4EEF6D236BF9381029BCAB63C` before = after; diff-quiet 0; gate rerun exit 0, `check-host-card-claims: 41 labels classified, 3 controls classified, 600 host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified, 3 capability emitters scanned.`; `git diff --quiet -- src config mobile` 0 |
