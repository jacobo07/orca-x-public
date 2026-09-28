// Durable copy of text the user has invested in but not yet handed off: a chat
// composer draft, an unsaved markdown edit, a transcript that had nowhere to go.
// React state dies with the process; this does not.
//
// Every operation reports an explicit outcome. "Nothing stored", "stored entry is
// corrupt" and "storage failed" are different facts and are never folded into an
// empty draft, because an empty draft is exactly what a restore offer skips.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha256'
import { z } from 'zod'

const STORAGE_PREFIX = 'orca:user-draft:v1:'
const MAX_SALVAGE_ENTRIES = 50

export type DraftSurface =
  | 'chat-composer'
  | 'markdown-editor'
  | 'terminal-command'
  | 'dictation-salvage'

export type DraftIdentity = {
  readonly surface: DraftSurface
  readonly hostId: string
  readonly worktreeId: string
  /** Tab id for a composer, document/tab id for an editor, null for per-worktree surfaces. */
  readonly subjectId: string | null
}

const SalvageEntrySchema = z
  .object({ text: z.string().min(1), capturedAt: z.number().int().nonnegative() })
  .strict()

const DraftRecordSchema = z
  .object({
    v: z.literal(1),
    surface: z.enum(['chat-composer', 'markdown-editor', 'terminal-command', 'dictation-salvage']),
    hostId: z.string().min(1),
    worktreeId: z.string().min(1),
    subjectId: z.string().min(1).nullable(),
    text: z.string().min(1),
    updatedAt: z.number().int().nonnegative(),
    /** Version of the remote content the edit was made against (editor only). */
    baseVersion: z.string().nullable(),
    entries: z.array(SalvageEntrySchema).max(MAX_SALVAGE_ENTRIES).optional()
  })
  .strict()

export type DraftRecord = z.infer<typeof DraftRecordSchema>
export type SalvageEntry = z.infer<typeof SalvageEntrySchema>

export type DraftLoadOutcome =
  | { readonly kind: 'draft'; readonly draft: DraftRecord }
  | { readonly kind: 'none' }
  /** A stored entry existed and could not be trusted; it has been removed. */
  | { readonly kind: 'unreadable' }
  /** Storage itself failed; nothing is known about the entry and nothing was removed. */
  | { readonly kind: 'failed'; readonly error: Error }

export type DraftSaveOutcome =
  | { readonly kind: 'saved'; readonly draft: DraftRecord }
  /** Empty text: the entry was removed, so a clean state never produces a restore offer. */
  | { readonly kind: 'removed' }
  | { readonly kind: 'failed'; readonly error: Error }

export type DraftClearOutcome =
  | { readonly kind: 'cleared' }
  | { readonly kind: 'kept-newer' }
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly error: Error }

export type DraftPurgeOutcome =
  | { readonly kind: 'purged'; readonly removed: number }
  | { readonly kind: 'failed'; readonly error: Error }

const keyMutations = new Map<string, Promise<void>>()

function digestHex(value: string): string {
  return Array.from(sha256(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function storageKey(identity: DraftIdentity): string {
  return `${STORAGE_PREFIX}${digestHex(
    JSON.stringify([identity.surface, identity.hostId, identity.worktreeId, identity.subjectId])
  )}`
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function matchesIdentity(record: DraftRecord, identity: DraftIdentity): boolean {
  return (
    record.surface === identity.surface &&
    record.hostId === identity.hostId &&
    record.worktreeId === identity.worktreeId &&
    record.subjectId === identity.subjectId
  )
}

function parseRecord(raw: string): DraftRecord | null {
  try {
    const result = DraftRecordSchema.safeParse(JSON.parse(raw))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

async function withKeyMutation<T>(identity: DraftIdentity, action: () => Promise<T>): Promise<T> {
  const key = storageKey(identity)
  const previous = keyMutations.get(key) ?? Promise.resolve()
  const operation = previous.then(action, action)
  const tail = operation.then(
    () => undefined,
    () => undefined
  )
  keyMutations.set(key, tail)
  try {
    return await operation
  } finally {
    if (keyMutations.get(key) === tail) {
      keyMutations.delete(key)
    }
  }
}

/** Read a stored entry. Throws only on storage failure; corrupt entries are removed. */
async function readUnlocked(
  identity: DraftIdentity
): Promise<{ kind: 'draft'; draft: DraftRecord } | { kind: 'none' } | { kind: 'unreadable' }> {
  const key = storageKey(identity)
  const raw = await AsyncStorage.getItem(key)
  if (raw === null) {
    return { kind: 'none' }
  }
  const record = parseRecord(raw)
  if (!record || !matchesIdentity(record, identity)) {
    // Why: a corrupt entry must be reported, not returned as empty — and removed so
    // it cannot shadow the next good write forever.
    await AsyncStorage.removeItem(key)
    return { kind: 'unreadable' }
  }
  return { kind: 'draft', draft: record }
}

export async function loadDraft(identity: DraftIdentity): Promise<DraftLoadOutcome> {
  return withKeyMutation(identity, async () => {
    try {
      return await readUnlocked(identity)
    } catch (error) {
      return { kind: 'failed', error: asError(error) }
    }
  })
}

export async function saveDraft(
  identity: DraftIdentity,
  text: string,
  options: { readonly baseVersion?: string | null; readonly now?: number } = {}
): Promise<DraftSaveOutcome> {
  return withKeyMutation(identity, async () => {
    const key = storageKey(identity)
    try {
      if (text === '') {
        await AsyncStorage.removeItem(key)
        return { kind: 'removed' }
      }
      const draft = DraftRecordSchema.parse({
        v: 1,
        surface: identity.surface,
        hostId: identity.hostId,
        worktreeId: identity.worktreeId,
        subjectId: identity.subjectId,
        text,
        updatedAt: options.now ?? Date.now(),
        baseVersion: options.baseVersion ?? null
      })
      await AsyncStorage.setItem(key, JSON.stringify(draft))
      return { kind: 'saved', draft }
    } catch (error) {
      return { kind: 'failed', error: asError(error) }
    }
  })
}

/** Remove the entry only if it still holds exactly the text that was confirmed
 *  (sent, saved). Anything typed after the confirmation survives. */
export async function clearDraftAfterConfirmed(
  identity: DraftIdentity,
  confirmedText: string,
  options: { readonly ignoreSurroundingWhitespace?: boolean } = {}
): Promise<DraftClearOutcome> {
  return withKeyMutation(identity, async () => {
    try {
      const current = await readUnlocked(identity)
      if (current.kind !== 'draft') {
        return { kind: 'none' }
      }
      const same = options.ignoreSurroundingWhitespace
        ? current.draft.text.trim() === confirmedText.trim()
        : current.draft.text === confirmedText
      if (!same) {
        return { kind: 'kept-newer' }
      }
      await AsyncStorage.removeItem(storageKey(identity))
      return { kind: 'cleared' }
    } catch (error) {
      return { kind: 'failed', error: asError(error) }
    }
  })
}

/** Keep a transcript that reached no surface. Appends; never replaces earlier salvage. */
export async function appendDictationSalvage(
  scope: { readonly hostId: string; readonly worktreeId: string },
  text: string,
  now: number = Date.now()
): Promise<DraftSaveOutcome> {
  const identity: DraftIdentity = {
    surface: 'dictation-salvage',
    hostId: scope.hostId,
    worktreeId: scope.worktreeId,
    subjectId: null
  }
  return withKeyMutation(identity, async () => {
    try {
      const current = await readUnlocked(identity)
      const previous = current.kind === 'draft' ? (current.draft.entries ?? []) : []
      // Why: bounded so a stuck target cannot grow one AsyncStorage value forever;
      // the oldest salvage is the one dropped.
      const entries = [...previous, { text, capturedAt: now }].slice(-MAX_SALVAGE_ENTRIES)
      const draft = DraftRecordSchema.parse({
        v: 1,
        ...identity,
        text: entries.map((entry) => entry.text).join('\n\n'),
        updatedAt: now,
        baseVersion: null,
        entries
      })
      await AsyncStorage.setItem(storageKey(identity), JSON.stringify(draft))
      return { kind: 'saved', draft }
    } catch (error) {
      return { kind: 'failed', error: asError(error) }
    }
  })
}

/** Remove every draft belonging to a removed host. Unreadable entries are left:
 *  their owner cannot be established, and they are removed on their own next load. */
export async function purgeHostDrafts(hostId: string): Promise<DraftPurgeOutcome> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(STORAGE_PREFIX))
    if (keys.length === 0) {
      return { kind: 'purged', removed: 0 }
    }
    const pairs = await AsyncStorage.multiGet(keys)
    const doomed = pairs
      .filter(([, raw]) => raw !== null && parseRecord(raw)?.hostId === hostId)
      .map(([key]) => key)
    if (doomed.length > 0) {
      await AsyncStorage.multiRemove(doomed)
    }
    return { kind: 'purged', removed: doomed.length }
  } catch (error) {
    return { kind: 'failed', error: asError(error) }
  }
}

export function getDraftStorageKeyForTests(identity: DraftIdentity): string {
  return storageKey(identity)
}

/** Test-only: drain in-memory queues while preserving the durable storage mock. */
export function resetDraftJournalForTests(): void {
  keyMutations.clear()
}
