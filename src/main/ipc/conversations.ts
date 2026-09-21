import { ipcMain } from 'electron'

import { isConversationId } from '../../shared/conversation-identity'
import type { ConversationSummary } from '../../shared/conversation-summary'
import type { ConversationLoadResult, ConversationRecord } from '../../shared/conversation-types'
import { ConversationService } from '../conversation/conversation-service'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { getOrcaConversationsDirectory } from '../orca-profiles/profile-storage-paths'

/**
 * Why the renderer gets these four and not a file API: a conversation is a product entity, and the
 * durability that protects it — the temp path, the fsync-before-rename barrier, the ordering
 * watermark and the compare-and-swap that fences it — is main's to keep. A renderer that could send
 * a `nextSeq` could defeat the check that stops a stale writer overwriting newer messages.
 *
 * The active profile is resolved on every call rather than captured at registration, so switching
 * profile takes effect immediately instead of serving the old profile's conversations until restart.
 */

export type ConversationIpcHandlers = {
  'conversations:list': () => Promise<ConversationSummary[]>
  'conversations:create': (args: {
    title?: string | null
    projectId?: string | null
  }) => Promise<ConversationRecord>
  'conversations:read': (args: { id: string }) => Promise<ConversationLoadResult>
}

/**
 * A malformed id THROWS rather than returning an outcome, matching ConversationStore: the four load
 * outcomes are statements about the user's data, and a renderer sending a string that is not an
 * Orca id is a bug in the renderer. Folding it into `unreadable` would report our own defect as
 * their conversation being corrupt.
 */
function requireConversationId(value: unknown): string {
  if (!isConversationId(value)) {
    throw new Error(`conversations: refusing a value that is not a conversation id: ${String(value)}`)
  }
  return value
}

export function createConversationIpcHandlers(
  service: ConversationService
): ConversationIpcHandlers {
  // Every handler is `async` so a rejected input is a REJECTED PROMISE and not a synchronous
  // throw. Electron would paper over the difference — ipcMain.handle catches both — but the type
  // here says `Promise`, and a function that sometimes throws before returning one breaks every
  // caller that reasonably does `.catch()` instead of wrapping in try/catch.
  return {
    'conversations:list': async () => service.list(),
    'conversations:create': async (args) =>
      service.create({
        title: typeof args?.title === 'string' ? args.title : null,
        projectId: typeof args?.projectId === 'string' ? args.projectId : null
      }),
    'conversations:read': async (args) => service.read(requireConversationId(args?.id))
  }
}

let cachedService: ConversationService | null = null

export function getConversationService(): ConversationService {
  cachedService ??= new ConversationService(() =>
    getOrcaConversationsDirectory(ensureActiveOrcaProfile().profile.id)
  )
  return cachedService
}

export function registerConversationHandlers(): void {
  const handlers = createConversationIpcHandlers(getConversationService())
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, args) =>
      (handler as (input: unknown) => Promise<unknown>)(args)
    )
  }
}
