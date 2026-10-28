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
| P21-S1 G5 scope: the innermost-control condition made always true (D-09 a, gate code) | `config/scripts/host-card-effect-claims.mjs:152-156` (LF, no BOM), in `checkEffectWordingScope`: the five-line `    if (` / `      action?.kind !== 'effect' \|\|` / `      typeof action.rpc !== 'string' \|\|` / `      !rpcMethods.has(action.rpc)` / `    ) {` -> `    if (false) {` (the enclosing control always reads as a backed effect) | yes: anchor text hits 1; only `config/scripts/host-card-effect-claims.mjs`; `1 file changed, 1 insertion(+), 5 deletions(-)` | CAUGHT: `vitest run config/scripts/host-card-effect-claims.test.mjs` exit 1, `FAIL ... > host-card-effect-claims: per-control effect wording (G5 scope) > fails Wake inside host-card-open while host-card-wake is a backed sibling (the D-09 weakening)` (`expected [] to deeply equal [ Array(1) ]`), plus seven scope-table rows (`unbacked effect`, `siblings`, `attributes: the same label on a navigation control`, `template: ... outside every control`, `imports`, `self-closing`, `depth: an inner same-name element`), `Tests 8 failed \| 23 passed (31)` | RESTORE_VERIFIED: sha256 `5EE0D017B75DB0EB48E7BEFAFE3BA9EF8C0C9F7F0CAE3657DAE4AED34EE2E720` before = after; diff-quiet 0; catcher rerun exit 0, `Tests 31 passed (31)` |
| P21-S2 effect wording on another control, real card (D-09 a) | `mobile/src/components/MobileHostCard.tsx:152-154` (LF, no BOM), inside `host-card-open`: the three-line `<Text testID="host-card-capabilities" style={styles.worktreeMetaText} numberOfLines={2}>` / `{availability.capabilityText}` / `</Text>` -> the same three lines + `          <Text>Wake now</Text>` | yes: anchor text hits 1; only `mobile/src/components/MobileHostCard.tsx`; `1 file changed, 1 insertion(+)` | CAUGHT: `pnpm.cmd run check:host-card-claims` exit 1, `check-host-card-claims: 1 problem(s)`, `- mobile/src/components/MobileHostCard.tsx:155 effect wording "Wake now" but no effect control classified to a host RPC method encloses it` (host-card-wake, a backed sibling, does not legitimize it) | RESTORE_VERIFIED: sha256 `A690A402685074B2299E9B844D49712172C4242288EA71A8D5CC0E790EF07761` before = after; diff-quiet 0; gate rerun exit 0 with the success line |
| P21-W1 Woken rendered from packet-sent (D-09 c) | `mobile/src/components/host-availability-presentation.ts:54` (CRLF, no BOM): `'wake.packet-sent': 'Wake packet sent',` -> `'wake.packet-sent': 'Woken',` | yes: anchor text hits 1; only `mobile/src/components/host-availability-presentation.ts`; `1 file changed, 1 insertion(+), 1 deletion(-)` | CAUGHT (both): (1) GATE laptop: `pnpm.cmd run check:host-card-claims` exit 1, `check-host-card-claims: 1 problem(s)`, `- label "wake.packet-sent" reads "Woken" — only the target's own answer may say the host woke` (W3); (2) UNIT GEX44: runner `-Mode test -Sync mobile/src/components/host-availability-presentation.ts -Files src/components/host-availability-presentation.test.ts`, root `/tmp/orca-phone-p18-20261028T155530Z`, `RUNNER synced=1 mobile files: src/components/host-availability-presentation.ts`, `FAIL ... > presentHostCardWake > text law: no broker- or phone-observed wake label reads as a woken host` (`expected 'Woken' not to match /\b(?:woken\|awake\|on\|up\|ready\|running…/i`) and `FAIL ... > presentHostCardWake > broker stages: requested, authorized and packet-sent show the packet sent, muted` (`expected 'Woken' to be 'Wake packet sent'`), `Tests 2 failed \| 69 passed (71)`, `RUNNER vitest_rc=1`, `RUNNER result=FAIL`, `TEARDOWN procs=0 root=absent`, `PROOF ROOT_ABSENT_CONFIRMED`, `LOCAL exit=1` | RESTORE_VERIFIED: sha256 `A001AA53979297E80C8FE811DA8CD1A90B722E0E473787C3744E234DBA19D4C8` before = after; diff-quiet 0; gate rerun exit 0 with the success line; GEX44 rerun in the batched restore run below (`RUNNER result=PASS`) |
| P21-B1 Wake control rendered without a broker binding, card (D-09 d) | `mobile/src/components/MobileHostCard.tsx:92` (LF, no BOM): `const showRequestControl = request.showControl && onRequest !== undefined` -> `const showRequestControl = onRequest !== undefined` (presence of onWake alone) | yes: anchor text hits 1; only `mobile/src/components/MobileHostCard.tsx`; `1 file changed, 1 insertion(+), 1 deletion(-)` | CAUGHT: UNIT GEX44: runner `-Mode test -Sync mobile/src/components/MobileHostCard.tsx -Files src/components/MobileHostCard.test.tsx`, root `/tmp/orca-phone-p18-20261028T155613Z`, `RUNNER synced=1 mobile files: src/components/MobileHostCard.tsx`, `FAIL ... > MobileHostCard Wake control > draws no Wake control when the broker entry carries no hostKey (control without binding)` and `FAIL ... > MobileHostCard Wake control > draws no Wake control when the host itself answered and reads awake` (each `expected [ ReactTestInstance{ …(1) } ] to have a length of +0 but got 1`), `Tests 2 failed \| 13 passed (15)`, `RUNNER result=FAIL`, `TEARDOWN procs=0 root=absent`, `PROOF ROOT_ABSENT_CONFIRMED`, `LOCAL exit=1` | RESTORE_VERIFIED: sha256 `A690A402685074B2299E9B844D49712172C4242288EA71A8D5CC0E790EF07761` before = after; diff-quiet 0; GEX44 rerun in the batched restore run below (`RUNNER result=PASS`) |
| P21-B2 composer: the entry hostKey equality made always true (D-09 d, wrong host) | `src/shared/host-wake-proxy.ts:111` (CRLF, no BOM), in `boundTargetIds`: anchor `isHostKey(entry.hostKey) && entry.hostKey === hostKey` -> `isHostKey(entry.hostKey) && true` | yes: anchor text hits 1; only `src/shared/host-wake-proxy.ts`; `1 file changed, 1 insertion(+), 1 deletion(-)` | CAUGHT: `vitest run src/shared/host-wake-proxy.test.ts` exit 1, `FAIL ... > composeHostWakeRoute > other host: a target bound to K2 does not route a card whose key is K` (`expected { send: true, …(3) } to deeply equal { send: false, …(1) }`) and `FAIL ... > other host: a K2 binding beside the K binding on one broker is not ambiguity` (`expected { send: false, …(1) } to deeply equal { send: true, …(3) }`), `Tests 2 failed \| 47 passed (49)`. The no_bound_target rows without a well-formed entry key stay green, as they should: `isHostKey(entry.hostKey)` is not part of this plant | RESTORE_VERIFIED: sha256 `526352208DDB5690A0BB718EBBC9FFF22E6B646D9C805220C0774A54A09DE1C7` before = after; diff-quiet 0; catcher rerun exit 0, `Tests 49 passed (49)` |
| P21-A1 ambiguous broker resolved to the first match (D-04, orchestrator decision 8) | `src/shared/host-wake-proxy.ts:155` (CRLF, no BOM), the `matches.length > 1` branch: `    return { send: false, reason: 'ambiguous_broker' }` -> `    return { send: true, ...matches[0] }` | yes: anchor text hits 1; only `src/shared/host-wake-proxy.ts`; `1 file changed, 1 insertion(+), 1 deletion(-)` | CAUGHT: `vitest run src/shared/host-wake-proxy.test.ts` exit 1, `FAIL ... > composeHostWakeRoute > D-04: two available brokers both bind the card key` and `FAIL ... > D-04: two targets on one broker both bind the card key` (each `expected { send: true, …(3) } to deeply equal { send: false, …(1) }`), plus `reaches every route reason, each in the wire pattern` (`ambiguous_broker: expected false to be true`), `Tests 3 failed \| 46 passed (49)` | RESTORE_VERIFIED: sha256 `526352208DDB5690A0BB718EBBC9FFF22E6B646D9C805220C0774A54A09DE1C7` before = after; diff-quiet 0; catcher rerun exit 0, `Tests 49 passed (49)` |

### Batched GEX44 restore run (P21-W1 and P21-B1)

After both restores, with the tree at HEAD `18f0d037e` and `git diff --quiet -- src config mobile` exit 0, one runner
pass in test mode with no `-Sync` (HEAD bytes only) over both mobile catchers:

```
RUNNER root=/tmp/orca-phone-p18-20261028T155726Z mode=test host=kobicraft-gex44 node=v24.21.0 pnpm=12.15.0
RUNNER base=18f0d037e
RUNNER install=ok
 Test Files  2 passed (2)
      Tests  86 passed (86)
RUNNER vitest_rc=0
RUNNER result=PASS
TEARDOWN procs=0 root=absent
PROOF ROOT_ABSENT_CONFIRMED
LOCAL exit=0
```

What the drills showed:
- **Scope (S1, S2).** The gate code and the real card are both pinned. Breaking the innermost-control condition fails
  eight table rows, and wording inside `host-card-open` is refused even though a backed Wake control sits beside it.
- **R1.** An unknown rpc is refused by the action check, and the scope rule then refuses the control's own wording,
  because a control with no backend cannot legitimize anything.
- **W1.** Two independent catchers see a woken word on a broker stage: G7 W3 reads the classified label, and the
  presenter's text law reads the rendered text.
- **B1 and B2.** No binding, no control, at both layers. The card refuses to draw without `showControl`, and the composer
  routes only on an exact key, so another host's binding neither routes nor turns into ambiguity.
- **A1.** Two matches never pick one. The route-reason coverage row also fails, because `ambiguous_broker` becomes
  unreachable.

Driver defects: none. Each drill ran once and no run was discarded. Every drill reported `VERDICT caught_all=True`.

Exit code of `git diff --quiet -- src config mobile` after the last restore: 0
Gate summary line after the last restore: `check-host-card-claims: 41 labels classified, 3 controls classified, 600 host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified, 3 capability emitters scanned.`
