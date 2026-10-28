---
covers: [row-70, continue-here, session-transfer, provider-session, working-set]
tier: 2
status: proposed
owner-decision: 2026-10-18 "Transferir la sesión" (Continue here resume across hosts)
---

# Row 70: transfer a Claude session when Continue here moves to another host

## Problem (measured)

Continue here plans `resume` from evidence gathered under the **source** scope
(`project-working-set-restore.ts:134`), and that evidence can only see local files
(`working-set-restore-evidence.ts:107-137`). A laptop Claude session is therefore planned as
`resume / "Its agent session is on that host"` on GEX44, where `claude --resume <id>` answers
`No conversation found` (measured 2026-10-18, Claude Code 2.1.113). The planner's own contract says
"Only facts gathered on the target count" (`project-working-set-host-translation.ts:185`).

Measured the same day as orca-svc on GEX44: Claude resolves `--resume <id>` only in
`~/.claude/projects/<cwd with every non-alphanumeric replaced by '-'>/<id>.jsonl`; copying the
transcript there makes resume work, with or without rewriting the `cwd` fields inside it.

## Objective

When a working set is continued from the local host onto an SSH host, each Claude pane whose source
transcript exists is copied to the target's Claude project directory for the cwd the pane will start
in, verified there, and only then planned as `resume`. Every other provider pane on a cross-host
continue is `unavailable / not-confirmed`, never promised.

## Scope

In:
- Source host local, target host SSH (the only shape where main can read the source and write the
  target). Claude only (`providerSession.key === 'session_id'`).
- A main-process service `transferContinueSessions` behind one new IPC
  (`workingSet:transferContinueSessions`). Main reads the manifest itself; the renderer names a
  working set and a target, never a path.
- The continue path in `project-working-set-restore.ts`: pre-plan gate, then transfer (the last
  await), then the authoritative plan and apply on target facts.

Out (stay `not-confirmed`, disclosed):
- Codex and every other agent; SSH -> local; SSH -> SSH.
- A remote shell that sets its own `CLAUDE_CONFIG_DIR` (Orca sets none over SSH and its hook
  installer also writes `$HOME/.claude`, `hook-settings.ts:107-109`).

## Design

1. **Pre-plan gate (sync, no effect).** Translate and plan as today. If the plan is refused (setup,
   host, `current-work-present`, ...), return the refusal: nothing is copied on a refusal.
2. **Transfer (the last await).** For each pane with `resume.kind === 'provider-session'`,
   agent `claude`, key `session_id`:
   - The id must match `^[A-Za-z0-9][A-Za-z0-9-]{0,127}$`, else skip (`not-confirmed`): the id is the
     file name, and the relay accepts any absolute path.
   - Source: the recorded `transcriptPath` if absolute and a file, else the resolver by id
     (`resolveSessionFilePath`). Over 64 MiB: skip.
   - Target cwd: the translated `entry.startupCwd ?? target worktreePath`. Destination
     `${remoteHome}/.claude/projects/${encode(cwd)}/${id}.jsonl`, `remoteHome` from the SSH session.
   - Create the directory, then an **exclusive** write (`writeFileBase64`, never overwrite). If the
     file already exists: identical bytes (sha256) count as present; different bytes are refused
     (it may be a live session on the target) and the pane is `not-confirmed`.
   - Verify by `stat` on the target (size equals the source).
   - Returns per pane `{ transcript: 'present' | 'unknown', location: 'present' | 'unknown' }`, plus a
     reason code per skipped pane for the evidence log. Never throws a whole continue for one pane.
3. **Authoritative plan on target facts (sync, after the await).** The continue's evidence for provider
   panes is replaced by the target facts: transferred and verified -> `present`; anything else
   `unknown`. Location is the target cwd's `stat`. Then `planContinueOnHost` and apply exactly as now.
   The plan is recomputed after the await, so the workspace it replaces is the one it sees.

No relay method is added: the writes use the existing main-side SSH filesystem provider, so no wire
capability is negotiated (`docs/reference/remote-wire-compatibility.md` rule 1-2 do not apply).

## Acceptance

Hermetic (vitest, red first where noted):
- Planner/continue: source-only evidence on a cross-host continue gives `not-confirmed`
  (RED on today's code); target `present` gives `resume`.
- Transfer service: traversal id refused with no write; exclusive create; identical existing file is
  present; different existing file refused with no write; missing source is unknown; size cap; the
  destination path for a Windows source and a Linux target cwd.
- Restore: a refused pre-plan calls no transfer.
- Mutant: a transfer that reports present without writing must turn the live leg red.

Live (REAL-SSH, laptop -> GEX44 as orca-svc, Owner OD-1 approval 2026-10-18):
- A real laptop Claude turn creates a session; the working set records it; Continue here onto the
  GEX44 replica plans `resume`; the file exists on GEX44 at the encoded path; Open runs
  `claude --resume <id>` there and the resumed session answers the word it was told on the laptop.
- orca-svc's `~/.claude/settings.json` is backed up before and restored after (the remote hook
  installer writes it), `orca-dws-serve` MainPID unchanged, the copied transcript and project dir are
  removed in teardown, `REMAINING=0 PROC_COUNT=0`.

## Rollback

Revert the commit. Files already copied are additive transcripts under the target's
`~/.claude/projects`; the live leg removes its own.

## Family baseline (persistent_state)

No row, file or volume is deleted or overwritten by the product path: the write is exclusive and a
conflicting file is refused, so the destructive-state rules do not apply to it (NO APLICA). The live
leg's teardown deletes only the transcript and directory it created, named by exact path.
