# Live model turn 2026-10-18: row 59

## Plane

REAL-TWO-HOST. The Electron app from the e2e build on the desktop PC, driven through `orcaPage`. Real
`ssh -L` carrier to a private sshd on GEX44 that runs as the service account `orca-svc`, in the phase-70
disposable root `/tmp/orca-hwf-p70-20261018T130932Z`. The service account's own Claude login supplies the
credential; nothing was copied. Driver: `config/scripts/hwf-two-host-model-turn-driver.ps1`; evidence dir
`C:\Users\User\Apps\rbl\d4-ev-r59m-20261018-150931`.

## Command

```
npx playwright test tests/e2e/hwf-two-host-model-turn.spec.ts --config tests/playwright.config.ts \
  --project electron-headless --workers=1
```

with `SKIP_BUILD=1`, `ORCA_HWF_TWO_HOST=1`, `ORCA_HWF_RUN_FILE`. Permission mode is Manual
(`agentDefaultArgs.claude = ''`, read back). The Bypass dialog is never answered. The prompt is a
letters-only nonce, and the lowercase answer appears nowhere in the prompt.

## Result: 1 passed (PLAYWRIGHT_EXIT=0)

Lines copied from `driver.log`:

```
HWF59M_MANUAL=claude-default-args-empty
HWF59M_CLAUDE_PATH=/usr/local/bin/claude
HWF59M_ARGV_BYPASS_FLAG=absent
HWF59M_LAUNCH pid=12269 cwd=/tmp/orca-hwf-p70-20261018T130932Z/svc/repos/p16-replica
HWF59M_PROMPT_SENT=yes
HWF59M_OUTCOME=answered
HWF59M_TRANSCRIPT_MATCHES=1
REMAINING=0
PROC_COUNT=0
HWF_CLAUDE_PROJECTS=0
WITNESS_UNCHANGED=True
SVC_HOME_RESTORED=True
```

The answer was also found independently in a transcript the service account's Claude wrote on the host
(`sudo grep -rlF` count 1), and the service-account home was restored to its pre-run state.

## Rerun of the six remote-first legs on this tree: 3 passed, 1 failed, 2 not run

Evidence dir `C:\Users\User\Apps\rbl\d4-ev-r59rf-20261018-151125`, root
`/tmp/orca-hwf-p15-20261018T131126Z`. Test 4 failed on the supplementary stub launch, after
`HWF_AGENT_A_LAUNCH=observed` had printed:
`bash: /tmp/orca-hwf-p15-20261018T131126Z/bin/hwf-agent-stub: No such file or directory`. The provisioner
writes that file only through its `install-stub` verb, which the driver did not run. The driver now has
`-InstallStub`. Tests 5 and 6 did not run because they follow test 4. The second rerun was not done: free RAM
was 5.1 GB, under the 6 GB one-Electron gate.

## Not covered

- The six-leg rerun on this tree is not 6/6. The 2026-10-15 6/6 (`live-2026-10-15-row-59-remote-first-evidence.md`)
  was measured before the optional-parameter helper changes in this wave.
- The model turn ran one provider (Claude) on one host; Codex is not exercised.
