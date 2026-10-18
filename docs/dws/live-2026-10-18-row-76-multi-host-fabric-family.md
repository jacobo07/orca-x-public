# Row 76 - multi_host_fabric tower family (2026-10-18)

Where it lives: claude-power-pack worktree `C:\Users\User\Apps\pp-dws-rows-wt`, branch `dws/pp-rows`, commit `18bc67aa` (local, not pushed; push is Owner-gated).

- `vault/tower/families/multi_host_fabric.json` - same shape as the four existing families.
- `vault/tower/baselines/multi_host_fabric/B0.json` - built with `tools/family_baseline.py build-b0`; 6 candidates, 0 dropped. Each cites a line in this repo (`AGENTS.md` rules, `docs/dws/live-2026-10-18-row-59-model-turn-evidence.md`) whose quote was re-read at window 0, and carries a runnable check.
- `tools/test_tower_multi_host_fabric.py` - 12 gates.

## Test output

```text
V-MHF gates
  PASS V-MHF-B0-EXISTS                          B0 only, 6 active entries
  PASS V-MHF-ORIGINS-VERIFIED                   every cited quote is on its cited line
  PASS V-MHF-ALL-CHECKABLE                      every entry carries a runnable check
  PASS V-MHF-REAL-REPO-GREEN                    real Orca repo: 6/6 APPLIED_VERIFIED, would_block=False
  PASS V-MHF-COPY-STAYS-GREEN                   an unmutated copy of the subject is green (the copy itself does not cause red)
  PASS V-MHF-VIOLATION-GOES-RED                 service home left unrestored -> VIOLATED on its own entry, would_block=True
  PASS V-MHF-VIOLATION-IS-ISOLATED              exactly one entry went red
  PASS V-MHF-VERDICT-STAMPED                    report stamped multi_host_fabric/B0, chain OK
  PASS V-MHF-MISSING-RULE-GOES-RED              a repo without the wire-compatibility note is VIOLATED
  PASS V-MHF-CONTROL-FAMILY-LOADS               family file is read: ['kobiicraft_mode', 'multi_host_fabric', 'persistent_state', 'web_surface', 'wii_homebrew']
  PASS V-MHF-CONTROL-CLASSIFIES                 a host-remoto prompt selects the family; a hero-colour prompt does not
  PASS V-MHF-CONTROL-NO-FAMILY-NO-BASELINE      an unknown family judges NO_BASELINE, so green above is the family's

MHF_PASS=12/12  threshold=12/12
```n
## Reading it

- Green leg: the real repo judges 6/6 APPLIED_VERIFIED.
- Red legs: evidence flipped to `SVC_HOME_RESTORED=False` turns only the service-home entry VIOLATED; deleting `docs/reference/remote-wire-compatibility.md` from a copy turns only the mixed-version entry VIOLATED. An unmutated copy stays green, so the copy is not what causes red.
- Controls: the family file is loaded and the classifier selects it for a host-remoto prompt and not for a hero-colour prompt; an unknown family judges NO_BASELINE.
- Other tower tests on the PP tree: checks 23/23, donegate 12/12, inheritance 16/16, ratchet 22/22, select 15/15, capsule 16/16, o4 7/7, baseline_inheritance 31/31, family_baselines 22/22, family_injection 26/26 (PROMPTS gained the new family's pair). `test_baseline_generations` was already 15/16 before this change: other families' origins point at files absent on this machine (FILE_MISSING); none are multi_host_fabric.

## Not shown

The B0 entries are citations of Orca rules and live-run evidence, not a claim that every future multi-host change is covered.
