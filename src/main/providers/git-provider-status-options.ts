// Kept separate so the central cross-provider contract stays within its enforced size limit.
export type GitProviderStatusOptions = {
  includeIgnored?: boolean
  bypassEffectiveUpstreamNegativeCache?: boolean
  reuseLineStats?: boolean
  /** Merge-base OID to measure the branch line total against; omit to skip the work. */
  branchLineTotalMergeBase?: string
  /** Stamp each entry with the identity of its working-tree bytes, for a client that may later ask
   *  to discard one. Omit unless the caller can act destructively; it is a per-file read. */
  worktreeContentIdentity?: boolean
  signal?: AbortSignal
}
