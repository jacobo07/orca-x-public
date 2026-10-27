import {
  REVEAL_CONVERGENCE_SETTLE_MS,
  type RevealConvergenceVerdict
} from '../runtime/terminal-reveal-convergence'

type BreadcrumbDetail = Record<string, string | number | boolean | null>

export type RevealConvergenceSchedulerDeps = {
  readonly probe: (ptyId: string) => Promise<RevealConvergenceVerdict>
  readonly record: (kind: string, detail: BreadcrumbDetail) => void
  readonly redact: (ptyId: string) => string
  readonly settleMs?: number
  readonly setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

const MAX_REMEMBERED_DIVERGENCES = 256

/**
 * Judges a pane once per reveal: a false→true visibility transition schedules one settle-delayed
 * probe, a hide before it fires cancels it, and the same divergence is reported once. No polling —
 * a pane that stays visible is never re-judged until it is hidden and revealed again.
 */
export function createRevealConvergenceScheduler(deps: RevealConvergenceSchedulerDeps) {
  const settleMs = deps.settleMs ?? REVEAL_CONVERGENCE_SETTLE_MS
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number): ReturnType<typeof setTimeout> => setTimeout(callback, ms))
  const clearTimer =
    deps.clearTimer ?? ((timer: ReturnType<typeof setTimeout>): void => clearTimeout(timer))
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const reported = new Map<string, string>()

  const report = (ptyId: string, verdict: RevealConvergenceVerdict): void => {
    const id = deps.redact(ptyId)
    if (verdict.verdict === 'converged') {
      reported.delete(ptyId)
      return
    }
    if (verdict.verdict === 'unknown') {
      deps.record('reveal-convergence-unjudged', { id, reason: verdict.reason })
      return
    }
    const key = `${verdict.mirrorDigest}:${verdict.rendererDigest}`
    if (reported.get(ptyId) === key) {
      return
    }
    reported.delete(ptyId)
    reported.set(ptyId, key)
    if (reported.size > MAX_REMEMBERED_DIVERGENCES) {
      const oldest = reported.keys().next().value
      if (oldest !== undefined) {
        reported.delete(oldest)
      }
    }
    deps.record('reveal-convergence-anomaly', {
      id,
      rows: verdict.rows,
      divergentRows: verdict.divergentRows.length,
      firstDivergentRow: verdict.divergentRows[0] ?? null,
      mirror: verdict.mirrorDigest,
      renderer: verdict.rendererDigest
    })
  }

  return {
    onVisibility(ptyId: string, visible: boolean, wasVisible: boolean): void {
      if (!visible) {
        const timer = pending.get(ptyId)
        if (timer !== undefined) {
          clearTimer(timer)
          pending.delete(ptyId)
        }
        return
      }
      if (wasVisible || pending.has(ptyId)) {
        return
      }
      pending.set(
        ptyId,
        setTimer(() => {
          pending.delete(ptyId)
          // Why through a promise: a probe that throws synchronously must land as unjudged, not escape a timer.
          Promise.resolve()
            .then(() => deps.probe(ptyId))
            .then(
              (verdict) => report(ptyId, verdict),
              () =>
                deps.record('reveal-convergence-unjudged', {
                  id: deps.redact(ptyId),
                  reason: 'probe-failed'
                })
            )
        }, settleMs)
      )
    },
    forget(ptyId: string): void {
      const timer = pending.get(ptyId)
      if (timer !== undefined) {
        clearTimer(timer)
        pending.delete(ptyId)
      }
      reported.delete(ptyId)
    }
  }
}
