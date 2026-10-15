import type { ReplicaPairCompareResult, ReplicaPairView } from '../shared/replica-pair-view'
import { publishedReplicaRelation, type ReplicaRelation } from '../shared/workspace-replica-state'

export type ReplicaCommandOutput = { text: string; exitCode: number }

function unreachable(value: never): never {
  throw new Error(`Unhandled replica result: ${JSON.stringify(value)}`)
}

/** What a user may be told about a pair: an equal-but-unverified `same` is published as unknown. */
export function formatReplicaRelation(relation: ReplicaRelation, healthy: boolean): string {
  const published = publishedReplicaRelation(relation, healthy)
  switch (published.kind) {
    case 'same':
      return 'same'
    case 'ahead':
      return `ahead ${published.count}`
    case 'behind':
      return `behind ${published.count}`
    case 'diverged':
      return `diverged +${published.aheadCount}/-${published.behindCount}`
    case 'unrelated':
      return 'unrelated'
    case 'unknown':
      return `unverified (${published.reason})`
    default:
      return unreachable(published)
  }
}

function formatPairLine(view: ReplicaPairView): string {
  return [view.setupId, view.hostId, formatReplicaRelation(view.relation, view.healthy)].join('  ')
}

function isKnownPair(view: ReplicaPairView): boolean {
  return publishedReplicaRelation(view.relation, view.healthy).kind !== 'unknown'
}

/** Prints the published relation per pair; exit 0 only when every pair is known. */
export function formatReplicaCompare(result: ReplicaPairCompareResult): ReplicaCommandOutput {
  switch (result.status) {
    case 'ok':
      if (result.pairs.length === 0) {
        return { text: 'replica-compare: no other setups of this project to compare.', exitCode: 1 }
      }
      return {
        text: result.pairs.map(formatPairLine).join('\n'),
        exitCode: result.pairs.every(isKnownPair) ? 0 : 1
      }
    case 'refused':
      return {
        text: `replica-compare: refused (${result.reason}) — only this machine may compare its replicas.`,
        exitCode: 1
      }
    case 'unavailable':
      return {
        text: `replica-compare: unavailable (${result.reason}) — this host has no SSH relay session; run the command against the desktop app's runtime.`,
        exitCode: 1
      }
    case 'not-found':
      return { text: `replica-compare: not found (${result.reason}).`, exitCode: 1 }
    default:
      return unreachable(result)
  }
}
