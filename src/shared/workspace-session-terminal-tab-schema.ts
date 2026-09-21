/* Why a separate module: the legacy terminal tab record is the part of the workspace session that
 * keeps growing launch and lifecycle fields; see ./workspace-session-schema for the read policy. */
import { z } from 'zod'
import type { TuiAgent } from './tui-agent'
import { isValidTerminalTabId } from './terminal-tab-id'
import { isTuiAgent } from './tui-agent-config'

export const terminalTabIdSchema = z
  .string()
  .min(1)
  .refine(isValidTerminalTabId, 'terminal tab id must not contain ":"')

export const terminalTabSchema = z.object({
  id: terminalTabIdSchema,
  ptyId: z.string().nullable(),
  worktreeId: z.string(),
  title: z.string(),
  defaultTitle: z.string().optional(),
  generatedTitle: z.string().nullable().optional(),
  aiVaultTitle: z
    .object({
      agent: z.enum(['claude', 'codex']),
      sessionId: z.string(),
      title: z.string()
    })
    .nullable()
    .optional()
    .catch(undefined),
  quickCommandLabel: z.string().nullable().optional(),
  customTitle: z.string().nullable(),
  color: z.string().nullable(),
  isPinned: z.boolean().optional(),
  sortOrder: z.number(),
  createdAt: z.number(),
  generation: z.number().optional(),
  startupCwd: z.string().min(1).optional(),
  // Why: persist the launched agent so a restored idle agent tab keeps its
  // provider icon before any hook fires. `.catch(undefined)` keeps a stale or
  // unknown agent id from failing the whole-session parse (which would reset
  // every terminal/editor/browser to defaults).
  launchAgent: z
    .custom<TuiAgent>((v) => isTuiAgent(v))
    .optional()
    .catch(undefined),
  // Why these are here at all: z.object strips what it does not name, so a field absent from this
  // schema is written to disk and silently discarded on the next cold load. Both describe how the
  // terminal was launched, and losing them returns a WSL or Git Bash tab as the default shell.
  // `.catch(undefined)` degrades a bad value to "host default" rather than dropping the terminal —
  // forgetting a shell preference is recoverable, losing the tab is not.
  shellOverride: z.string().min(1).optional().catch(undefined),
  forceHostRuntime: z.boolean().optional().catch(undefined),
  launchProfileId: z.string().min(1).optional().catch(undefined),
  // Why `.catch`: a bad marker degrades to pre-dormancy behaviour (the tab mounts), never to a lost
  // session. `dormantOpenRequested` is deliberately absent: an open request must not outlive a restart.
  dormancy: z
    .object({ reason: z.enum(['working-set-restore', 'workspace-sleep']) })
    .optional()
    .catch(undefined)
})
