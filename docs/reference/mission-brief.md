---
covers: [mission-brief, goal-continuity, mission-frontier, next-best-action, resume-center-brief, what-needs-me]
status: PLANNED
---

# Mission Brief

Resume Center restores **where** work was. The Mission Brief restores **what the work was for**: the
objective, the frontier, what was last proven, the next step, what needs the human, what is already
running without them, and how fresh that belief is.

**The brief is not the truth. It is a projection of state owned elsewhere.** It stores nothing. Every
field names the producer that decided it, and a field whose producer has no answer says so.

Status per capability: **LIVE** (implemented and exercised by a test or a real run), **PLANNED**,
**UNSUPPORTED**. A sentence here may not run ahead of its status.

## Owners the brief reads (none replaced, none duplicated)

| Semantic | Producer | Notes |
|---|---|---|
| Workspace → path | `describeWorkspace` (`src/main/continuity/desk-read.ts`) | The renderer sends `(hostId, workspaceKey)`; main derives the path. |
| Planning snapshot | `gsd-tools planning inspect` | Milestone identity, active phase/plan/status, per-phase verification with GSD's own `next_action`, roadmap acceptance (`authoritative: false`), diagnostics. |
| Phase list, goals, dependencies | `gsd-tools roadmap analyze` | Covers phases with no directory yet. Its `progress_percent` is plan-counted and is **never rendered**. |
| Next step | `gsd-tools smart-entry --json` | The router `/gsd-next` uses: situation, recommended action, command. |
| Blockers, owner decisions, recorded commit | `.planning/STATE.md`, quoted verbatim | GSD's parsers return `null` for a `### Blockers/Concerns` subsection, so an empty GSD answer is not "no blockers". |
| Freshness | `STATE.md` `state_head` vs the workspace's git `HEAD` | `smart-entry` reports `has_git: false` on a linked worktree, so its staleness signal cannot be used. |
| Autonomous work, blocked-on-human | Ralph mission records `~/.claude/state/gsd-mission-*.json` | Matched by normalized `cwd`. Local host only. |

All GSD calls run with `--cwd <path>` (and `--ws <name>` when a workstream is chosen) through
Electron-as-Node, so no `node` on PATH is assumed and GSD's session pointer is never written.
If `~/.claude/gsd-core/bin/gsd-tools.cjs` is absent the brief is **unavailable**, not empty.

**Not owners yet:** InfinityOps/FTIF (Backlog Phase 6), Universal Backlog (unmerged), UWCP
Workstreams (DWS Phase 4), orchestration runs (no project key). The projection accepts them later as
additional producers; none is imitated now.

## Field contract

| Field | Rule | When the producer has no answer |
|---|---|---|
| Objective | Milestone name from `planning inspect`; else the ROADMAP title | `UNKNOWN` — never the repo name |
| Stage strip | Roadmap phases in their own names. A phase is **proven** only when its verification passed; **claimed** when the roadmap ticks it but verification is missing/stale; **current** = active phase; else future | A ticked box alone is never "complete" |
| Current frontier | Active phase from `planning inspect` | Disagreement with `STATE.md`'s frontmatter is shown as a contradiction, not resolved by choice |
| Last verified result | The newest phase whose verification `passed` | "No phase verified yet", with the nearest verification's status — never labelled Verified |
| Next best action | `smart-entry.recommended` + its label and command | "Next step unknown" |
| Unlocks | Phases whose `depends_on` names the frontier phase | Row omitted |
| Your intervention | Ralph `BLOCKED` with a reason; `OWNER DECISION NEEDED` lines in `STATE.md` | "Nothing recorded as waiting on you" — not "nothing needs you" |
| Work already running | Ralph mission in a running state with a heartbeat younger than 10 min | Omitted. Planned work is never shown as prepared |
| Risks / blockers | `STATE.md` Blockers section verbatim; Ralph reason; detected contradictions | "Blockers not recorded" |
| Freshness | `state_head == HEAD` → current; differs → stale (commits since); unreadable → unknown. Plus the read time | `UNKNOWN`, hollow dot |

No field is written by a model. No count or percentage is rendered that a producer did not measure.

## Actions

- **Continue mission** — re-reads the brief, then resumes the workspace's sleeping agent through the
  Resume Center's existing path (`continuity:admitWake` + canonical sleeping resume). Disabled with
  "Progressing autonomously" while a Ralph mission is running on that path; unavailable when the
  workspace holds no resumable agent. PLANNED.
- **Do what needs me** — navigates to where the human step lives (the `STATE.md` line of an owner
  decision; the workspace for a blocked mission). Voice/Focus Lens guidance is UNSUPPORTED and is
  labelled so. PLANNED.
- **View full path** — every phase from the same projection with its state, dependencies and
  evidence. No second roadmap. PLANNED.

## Placement

The brief is one component with a `full` and a `compact` layout. Selecting a Resume Center workspace
row replaces the Desk Summary aside with the compact brief; "Open full brief" shows the full layout in
a dialog. Each row carries a one-line signal from a brief already read (never a fresh read per row).
The global "what matters now" layer is PLANNED and only after the contextual brief is proven.

## Cost

A read is three GSD spawns (measured on this host: `planning inspect` 9.6 s, `smart-entry` 3.4 s,
under memory pressure). Reads are on demand only (selection, Refresh), single-flight per workspace,
at most two workspaces at once, cached until `.planning` or `HEAD` changes. No poll.

## Gates

- `check:workspace-surface-claims` — every brief value is a `ClaimValue` with a producer entry.
- `check:status-semantics` — attention uses `--agent-question` (`NEEDS_APPROVAL`), stale uses
  `PRESSURED` with its age, unknown the hollow mark.
- Projection tests are driven by real GSD output captured from a real repo, not hand-made fixtures.
