# Workspace hostile-content resilience

Orca spends its life hosting other people's output: huge diffs, failing builds, deep repositories,
verbose agents. This plan covers what happens to Orca's own chrome when that content is hostile —
long, deep, voluminous, or failing — and it deliberately covers nothing else.

## What was already true before this work

Most of the resilience this plan was originally scoped to build already exists. Measuring first
removed roughly two thirds of the intended work, and the measurements are recorded here so the next
person does not rebuild them either.

| Concern | Owner | Measured state |
| --- | --- | --- |
| Terminal wrapping, ANSI, emoji, wide glyphs | xterm.js via `src/renderer/src/lib/pane-manager/pane-dom-creation.ts` | Owned. Covered by the terminal-rendering-golden suite. |
| Output flood | `src/shared/terminal-scrollback-policy.ts` | Bounded: 5,000 rows default, 1,000–50,000 range, backlog cap `max(2 MB, rows × 120)`. |
| Terminal input flood | `src/shared/terminal-input.ts` | Bounded: 16 KB per chunk, 16 MB total. |
| Terminal autoscroll | `src/renderer/src/components/terminal-pane/terminal-scroll-intent.ts` | Explicit `followOutput` / `pinnedViewport` intent model. |
| Agent-surface autoscroll | `src/renderer/src/components/native-chat/native-chat-autoscroll.ts` | Separate owner, 48 px near-bottom threshold plus jump-to-latest. |
| Structured tool output | `NativeChatToolRun.tsx` | Bounded height plus two-level collapse. |
| Source-control diffs | `src/shared/large-diff-render-limit.ts` | 120,000 lines per side, 6,000,000 combined characters, section lazy-load. |
| Session rail long titles | `TerminalRailRow.tsx` | Truncates, keeps trailing controls unshrinkable, exposes the full title. |
| Session rail density | `TerminalRail.tsx` | Scrolls and resizes. |

## The semantic boundary this plan must not cross

Orca renders two different kinds of output and they are not interchangeable.

The **raw PTY surface** is byte-faithful terminal emulation. Its only semantic metadata is real OSC
133 shell integration (`src/shared/terminal-osc133-command-finished.ts`), which reports that a
command started and that it finished with a best-effort exit code. It carries no command text, and
the markers are deliberately swallowed so they never paint. Nothing in this plan may restyle,
reformat, collapse, or re-hierarchise PTY bytes. A prettier terminal that breaks terminal semantics
is a regression, and the terminal-rendering-golden and terminal-perf suites are the detector.

The **structured agent surface** (`src/renderer/src/components/native-chat/`) has real per-block
metadata and may present richly, because there it is describing structure it actually knows.

The single existing exception — `codex-backfill-error-detector.ts`, a string matcher for one known
error signature — is scoped to that one signature and must not be generalised. Inferring meaning
from arbitrary terminal text is out of bounds regardless of how much nicer the result would look.

## Scope

Six gaps survived measurement.

1. **No semantic error or warning tokens.** `src/renderer/src/assets/main.css` defines a full
   `--status-success` triad and a `--destructive` pair, but no error or warning equivalent.
   `destructive` is documented in `docs/STYLEGUIDE.md` as a role for irreversible *actions*, so
   state surfaces borrowing it are misusing it, and surfaces needing *warning* have nothing to use.
2. **Three distinct agent states render identically.** `AgentStateDot.tsx` collapses `blocked`,
   `interrupted` and `failed` into one red dot. Each carries a correct accessible name, so this is a
   visual-salience defect rather than an accessibility one: a failure cannot be told from a block
   without hovering.
3. **Token bypass.** `AgentStateDot.tsx` and `FileExplorerRow.tsx` paint from raw palette literals
   (`bg-red-500`, `text-emerald-500`, `amber-400`) where a documented token covers the role.
4. **File explorer indentation has no floor.** `FileExplorerRow.tsx` indents by `depth * 16 + 8`
   with no cap. In a narrow sidebar, deep nesting drives usable filename width toward zero.
5. **A truncated filename is unrecoverable.** `FileExplorerRow.tsx` truncates the name but attaches
   no tooltip, unlike the session rail. `docs/STYLEGUIDE.md` names truncated paths as a tooltip case.
6. **Nothing protects presentation geometry.** `config/reliability-gates.jsonc` has a mature
   runtime and lifecycle gate family and no presentation family, so every resilience listed in the
   table above is unprotected against regression. `docs/STYLEGUIDE.md` documents three overflow
   container styles but no policy for which content wraps, truncates, or scrolls.

## Out of scope

Terminal restyling of any kind. Command blocks rendered from OSC 133, which has no command text to
render. Rail width. Top chrome. Any new renderer, design system, diff viewer, layout engine, or
gate framework — each already has a live owner. Editor, debugger, docking, or VS Code parity work.

## Acceptance

- A file name stays readable, and its full value stays recoverable, at depth in a narrow sidebar.
- Error, warning, progress and success are four visually distinct states drawn from one token
  vocabulary, and none is distinguished by colour alone.
- No surface repaints its neighbour under hostile content.
- Each behaviour above is pinned by a test that failed before its fix, and the presentation gate
  family is registered in `config/reliability-gates.jsonc` so the ratchet holds.
- The terminal-rendering-golden and terminal-perf suites stay green, proving fidelity was preserved.

Geometry claims are proven in Playwright against a real rendered window. A `happy-dom` unit test
cannot measure layout and would report success without ever exercising the failure.

## Rollback

Every item is an independent commit. Tokens are additive. The state-dot and explorer changes are
local to one component each. The gate family is a manifest entry plus its specs. Any item can be
reverted alone without disturbing the others.
