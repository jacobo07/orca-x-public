---
covers: [workstation, workspace-workstation, host-reachability, workspace-nav]
status: DRAFT (Owner chose option A on 2026-10-02: build on this branch only, no dws merge)
branch: orca-x/product-convergence (Apps\orca-convergence-wt)
parent: docs/reference/workspace-convergence.md §2.7
---

# Workstation — Workspace destination (v1)

One page under Workspace that shows every host Orca knows, what Orca has actually observed about
each, which projects are set up on it, and which agents run there. It is a projection: it owns no
state and adds no producer, timer or poll.

## 1. Sources (all already in this branch)

| Fact | Producer |
|---|---|
| Hosts: local, SSH targets, runtime servers, hosts repos point at | `useSidebarHostScopeOptions().hostOptions` (`buildExecutionHostRegistry`) |
| Connection evidence | `SidebarHostOption.health`, `.connectionStatus` (SSH), `.compatibility` (runtime) |
| Projects per host | `projectHostSetups` grouped by `hostId`; names from the Project |
| Agents per host | `useWorkspaceRunningSessions()` (live dashboard snapshot), grouped by `hostId` |
| Host actions | `HostSectionHeaderMenu` (the sidebar's menu, reused — one action authority) |

## 2. Reachability is derived, never defaulted

The shared `ExecutionHostHealth` is a **connection** state: `'disconnected'` truthfully means Orca
holds no connection, and ~20 consumers rely on that. It is not a statement that the host is down, so
it is NOT changed. The page derives its own reachability:

| Reachability | When |
|---|---|
| `this-machine` | `kind === 'local'` |
| `reachable` | SSH `connectionStatus === 'connected'`, or runtime `health === 'available'` with a live status |
| `connecting` | `health === 'connecting'` |
| `failed` | SSH `auth-failed` / `error` / `reconnection-failed`, or runtime `health === 'error'` — Orca tried; the reason is shown |
| `blocked` | `health === 'blocked'` (version skew); the verdict's direction is shown |
| `unknown` | everything else, including never connected and disconnected — Orca has no current observation |

`unknown` is never rendered as healthy or as offline. A host that is not `reachable` cannot vouch for
its agents: their state reads "unknown while the host is not connected", not the last bucket and not
"offline".

## 3. Page

- `WorkspaceFrame` (breadcrumb Workspace › Workstation), destination `workstation` added to
  `WORKSPACE_DESTINATIONS` after Backlog; `activeView === 'workstation'` renders the page.
- Body: one card per host, this machine first, then by label. Card: label, kind, detail, reachability
  badge (text, not colour alone), the host menu, then **Projects** (name, path, saved setup state
  worded as setup — "Set up", "Not set up", "Setting up", "Setup failed", "Unsupported"; never
  "Ready", which reads as reachability) and **Agents** (title, project, state).
- A setup or session whose `hostId` no known host matches gets its own card labelled with the id and
  reachability `unknown`: nothing is dropped.
- Right column below Workspace navigation: a summary — hosts, by reachability, projects set up,
  agents. Every count is computed from the same projection the cards render.
- Empty states: no remote hosts → this machine's card plus one line pointing to Settings › SSH /
  Runtime environments (existing pages, by link). No setups / no agents on a host → say so.
- en + es strings; labels wrap (global-nav rule applies to cards too).

## 4. Out of scope (named, not hidden)

- Key-based host identity (`fleet.*` RPC is CLI-only) and per-host terminal (non-agent) inventory:
  no renderer producer exists. The page does not claim them.
- dws-only: replica roles, replica health presenter, Prepare this device — arrive with the dws merge.
- `RepositoryHostSetupsSection` "Ready" wording: fixed on dws (`290e9fc4b`); not touched here.
- ~~`projectRunningSessions` labelling a never-observed host's agents `host-offline`~~ FIXED
  `4d0c8ecd8` (`host-unvouched`). Marks: `StatusMark` (`38a85ec17`); a session on a host Orca cannot
  vouch for is `UNKNOWN` on Agents and Workstation alike, the host's failure drawn on the host
  (`e8f83eb47`, `agents-workstation-status-agreement.test.ts`). Real-app: the walk reads the
  marks' computed fill/ring in light and dark (`5186bd227`). Not observed in the real app: an Agents
  row for a session on an unobserved host (no cheap producer of a running agent there).

## 5. Acceptance

- Unit (pure presenter): every row of §2's table, each with a control that differs by one input;
  `'disconnected'` and missing `connectionStatus` both → `unknown`, never `reachable`; orphan setups and
  sessions get a card; counts equal the cards'. Mutation: map `undefined` connection to `reachable` →
  red.
- Unit (render): page lists the hosts it is given; host menu present per remote host; Workspace nav
  lists Workstation (`WorkspaceFrame.test.tsx` updated).
- e2e (real app, Windows + GEX44): the nav walk reaches Workstation from Workspace navigation; this
  machine's card shows the walk's test repo under Projects; an SSH target added through the app's own
  API and never connected renders reachability **unknown**; no label overflows; destination count
  includes Workstation in wide and strip layouts.
- `tc web` 0, oxlint/oxfmt clean on touched files.

Rollback: revert the commits; nothing is persisted.
