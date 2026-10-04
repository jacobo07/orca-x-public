import type { IssueLookupFailureEntry } from '@/store/slices/github'

// Why: a failed lookup caches nothing, so "no entry yet" alone cannot tell loading from failed.
export function getLinkedIssuePlaceholderTitle(
  issue: null | undefined,
  failure: IssueLookupFailureEntry | undefined
): string {
  return issue === null || failure !== undefined ? 'Issue details unavailable' : 'Loading issue...'
}
