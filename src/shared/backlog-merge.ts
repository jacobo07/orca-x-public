import type { BacklogCandidate, BacklogExecutionLink, BacklogSourceLink } from './backlog-types'

// NUL joins identity components; validation keeps every component NUL-free.
const sourceIdentity = (link: BacklogSourceLink): string =>
  `${link.kind}\0${link.ref}\0${link.candidateId ?? ''}`
const executionIdentity = (link: BacklogExecutionLink): string => `${link.kind}\0${link.ref}`

function union<T>(survivor: readonly T[], loser: readonly T[], identity: (link: T) => string): T[] {
  const seen = new Set(survivor.map(identity))
  const merged = [...survivor]
  for (const link of loser) {
    const key = identity(link)
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(link)
    }
  }
  return merged
}

/** Survivor links first in their order, then each loser link the survivor lacks: none is dropped. */
export function unionBacklogSourceLinks(
  survivor: readonly BacklogSourceLink[],
  loser: readonly BacklogSourceLink[]
): BacklogSourceLink[] {
  return union(survivor, loser, sourceIdentity)
}

export function unionBacklogExecutionLinks(
  survivor: readonly BacklogExecutionLink[],
  loser: readonly BacklogExecutionLink[]
): BacklogExecutionLink[] {
  return union(survivor, loser, executionIdentity)
}

export function backlogSourceLinkFromCandidate(candidate: BacklogCandidate): BacklogSourceLink {
  return {
    kind: candidate.source.kind,
    ref: candidate.source.ref,
    capturedAt: candidate.source.capturedAt,
    candidateId: candidate.id
  }
}
