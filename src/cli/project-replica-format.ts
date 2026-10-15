import type {
  ReplicaCapsuleCreateResult,
  ReplicaCapsuleListResult,
  ReplicaCapsuleRestoreResult
} from '../shared/replica-capsule-view'
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

const SHORT = 7

function capsuleRefusalText(command: string, reason: string, setupId: string): string {
  if (reason === 'remote-capsule-unsupported') {
    return `${command}: refused (${reason}) — capsules work on a local setup only; setup ${setupId} is not on this machine.`
  }
  return `${command}: refused (${reason}).`
}

/** Captures a dirty worktree; created and clean exit 0, anything else 1. */
export function formatReplicaCapsuleCreate(
  result: ReplicaCapsuleCreateResult,
  setupId: string
): ReplicaCommandOutput {
  switch (result.status) {
    case 'ok': {
      const outcome = result.outcome
      if (outcome.kind === 'clean') {
        return { text: 'nothing to capture: the worktree is clean', exitCode: 0 }
      }
      const lines = [`created ${outcome.ref} (base ${outcome.base.slice(0, SHORT)})`]
      if (outcome.alreadyExisted) {
        lines.push('already existed')
      }
      if (outcome.partial) {
        lines.push(`partial: ${outcome.omissions.length} paths omitted`)
      }
      return { text: lines.join('\n'), exitCode: 0 }
    }
    case 'refused':
      return {
        text: capsuleRefusalText('replica-capsule', result.reason, setupId),
        exitCode: 1
      }
    case 'unavailable':
      return {
        text: `replica-capsule: unavailable (${result.reason}) — this host has no replica service.`,
        exitCode: 1
      }
    case 'not-found':
      return { text: `replica-capsule: not found (${result.reason}).`, exitCode: 1 }
    default:
      return unreachable(result)
  }
}

/** One line per capsule; exit 1 when any is damaged. */
export function formatReplicaCapsuleList(
  result: ReplicaCapsuleListResult,
  setupId: string
): ReplicaCommandOutput {
  switch (result.status) {
    case 'ok': {
      if (result.capsules.length === 0) {
        return { text: 'no capsules', exitCode: 0 }
      }
      const lines = result.capsules.map((capsule) =>
        'damaged' in capsule
          ? `damaged ${capsule.ref} (${capsule.reason})`
          : `${capsule.ref}  base ${capsule.baseTip.slice(0, SHORT)}${capsule.partial ? '  partial' : ''}`
      )
      return {
        text: lines.join('\n'),
        exitCode: result.capsules.some((capsule) => 'damaged' in capsule) ? 1 : 0
      }
    }
    case 'refused':
      return {
        text: capsuleRefusalText('replica-capsule-list', result.reason, setupId),
        exitCode: 1
      }
    case 'unavailable':
      return {
        text: `replica-capsule-list: unavailable (${result.reason}) — this host has no replica service.`,
        exitCode: 1
      }
    case 'not-found':
      return { text: `replica-capsule-list: not found (${result.reason}).`, exitCode: 1 }
    default:
      return unreachable(result)
  }
}

/** Plan or apply a capsule; refused and failed exit 1, with the recovery text verbatim. */
export function formatReplicaCapsuleRestore(
  result: ReplicaCapsuleRestoreResult,
  setupId: string
): ReplicaCommandOutput {
  switch (result.status) {
    case 'ok': {
      const outcome = result.outcome
      const counts = `tracked ${outcome.changes.tracked}, staged ${outcome.changes.staged}, untracked ${outcome.changes.untracked}`
      if (outcome.kind === 'plan') {
        return {
          text: `plan ${outcome.ref} onto base ${outcome.base.slice(0, SHORT)}: ${counts}\nplan only; re-run with --apply to change the worktree`,
          exitCode: 0
        }
      }
      const lines = [`applied ${outcome.ref}: ${counts}`]
      if (outcome.recaptureRef) {
        lines.push(`recapture ${outcome.recaptureRef}`)
      }
      lines.push(...outcome.warnings.map((warning) => `warning: ${warning}`))
      return { text: lines.join('\n'), exitCode: 0 }
    }
    case 'refused': {
      const head = capsuleRefusalText('replica-capsule-restore', result.reason, setupId)
      return { text: result.detail ? `${head}\n${result.detail}` : head, exitCode: 1 }
    }
    case 'failed':
      return {
        text: `replica-capsule-restore: failed (${result.reason}) ${result.ref}\n${result.detail}\n${result.recovery}`,
        exitCode: 1
      }
    case 'unavailable':
      return {
        text: `replica-capsule-restore: unavailable (${result.reason}) — this host has no replica service.`,
        exitCode: 1
      }
    case 'not-found':
      return { text: `replica-capsule-restore: not found (${result.reason}).`, exitCode: 1 }
    default:
      return unreachable(result)
  }
}
