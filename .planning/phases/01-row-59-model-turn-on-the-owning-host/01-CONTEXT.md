# Phase 1: Row 59 model turn on the owning host - Context

**Gathered:** 2026-10-18
**Status:** Ready for planning
**Mode:** Decisions pre-bound by Owner (STATE.md "Owner decisions 2026-10-18"); no grey area left open

<domain>
## Phase Boundary

Measure the one open gap of matrix row 59: a real Claude prompt typed in the owning-host (GEX44) agent pane
is answered, the process runs in the host repo, and the answer reaches the client. The existing 6 legs of
`tests/e2e/hwf-two-host-remote-first.spec.ts` must still pass. Ends with evidence doc, row 59 restated, Orca push.
</domain>

<decisions>
## Implementation Decisions

### Harness
- Build on `hwf-two-host-remote-first.spec.ts` plus the phase-70 orca-svc harness (`create-svc`, `seed-svc`, `svc-backup`, `svc-restore`, `svc-teardown`); driver modelled on `C:\Users\User\Apps\rbl\d4-p70.ps1` (a new `d4-p59.ps1`). No new transport.
- Model turn runs as orca-svc (its real home holds the Claude login); the svc home is backed up before and restored after.

### Permissions
- Manual agent permissions: `agentDefaultArgs.claude = ''`. The Bypass Permissions dialog is NEVER answered; the poll returns `bypass-consent-asked`.
- Trust-folder dialog may be answered per poll (as in row 70).

### Assertion
- Nonce prompt typed in the owning-host agent pane; the expected answer string is never present in the prompt (e.g. ask for the nonce reversed/lowercased). Screen read maps CSI `ESC[<n>C` to a space before `stripAnsiEscapeSequences`.
- Independent instrument: claude process cwd on GEX44 is the host repo, observed outside the app.

### Done gates
- `SVC_HOME_RESTORED=True`, `HWF_CLAUDE_PROJECTS=0`, teardown REMAINING=0 PROC_COUNT=0, witness unchanged. Laptop free RAM >= 6 GB; one Electron at a time.
- Row 59 restated from what was measured (PASS only if whole `done` met; otherwise PARTIAL with the named gap). Never mark PASS from a skipped test.

### Claude's Discretion
Where the new test lives (new spec file vs. added test), helper naming, poll intervals.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `tests/e2e/hwf-two-host-continue-here-resume.spec.ts`: Manual-mode setting, trust poll, Ink screen cleaning, nonce answer poll.
- `tests/e2e/helpers/hwf-two-host-agent-launch.ts`: `launchProviderOnOwningHost`, `readActivePaneKey`, root-proc listing.
- `tests/e2e/helpers/hwf-two-host-session.ts` `bootHwfSession`, `hwf-two-host-ssh-target.ts` `execOnOwningHost`.

### Established Patterns
- Opt-in specs skip (NOT RUN) without `ORCA_HWF_TWO_HOST=1` + `ORCA_HWF_RUN_FILE`; e2e uses `orcaPage`.

### Integration Points
- `config/dws-completion-matrix.jsonc` row 59 (exact-string edit, no oxfmt); `docs/dws/live-2026-10-18-row-59-*.md`.
</code_context>

<specifics>
## Specific Ideas

Existing evidence: docs/dws/live-2026-10-15-row-59-remote-first-evidence.md (6/6 legs, no model turn).
</specifics>

<deferred>
## Deferred Ideas

None.
</deferred>