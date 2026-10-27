/** Main asks a window to prepare for reload; the preload answers on `app:reloadPreparationSettled`. */
export type ReloadPreparationRequest = { requestId: string }

export type ReloadPreparationAnswer = {
  requestId: string
  outcome: 'prepared' | 'refused'
}

/** `proceed: false` means main will not reload for this answer, so the renderer must stand down. */
export type ReloadPreparationReply = { proceed: boolean }

export function isReloadPreparationAnswer(value: unknown): value is ReloadPreparationAnswer {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const { requestId, outcome } = value as Record<string, unknown>
  return typeof requestId === 'string' && (outcome === 'prepared' || outcome === 'refused')
}
