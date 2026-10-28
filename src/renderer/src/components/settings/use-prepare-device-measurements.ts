import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildPreparePlan,
  type PreparePlan,
  type PrepareStep
} from '../../../../shared/environment-prepare-plan'
import type { PrepareStepRunOutcome } from '../../../../shared/environment-prepare-run-result'
import type { EnvironmentRequirementsMeasurement } from '../../../../shared/environment-requirements-measurement'
import type { PersistedTrustedOrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import { rendererPrepareSha256Hex } from '../../lib/prepare-approval-hash'
import {
  measureRequirementsForRuntimeTarget,
  runPrepareStepForRuntimeTarget
} from '../../runtime/runtime-environment-requirements-client'
import { readPrepareApprovals } from '../../store/slices/prepare-approval'
import type { PrepareHostBlockSpec } from './prepare-host-blocks'

export type HostBlockMeasurement =
  | { phase: 'idle' }
  | { phase: 'measuring' }
  | { phase: 'failed' }
  | { phase: 'host-predates-probes' }
  | { phase: 'measured'; result: EnvironmentRequirementsMeasurement }

export type PrepareRunNote = { requirementId: string; outcome: PrepareStepRunOutcome }

const IDLE: HostBlockMeasurement = { phase: 'idle' }

export function usePrepareDeviceMeasurements(
  blocks: readonly PrepareHostBlockSpec[],
  trustedOrcaHooks: PersistedTrustedOrcaHooks
): {
  measurements: Record<string, HostBlockMeasurement>
  plans: Record<string, PreparePlan>
  runs: Record<string, PrepareRunNote>
  measure: (block: PrepareHostBlockSpec) => Promise<void>
  run: (block: PrepareHostBlockSpec, step: PrepareStep, plan: PreparePlan) => Promise<void>
} {
  const [measurements, setMeasurements] = useState<Record<string, HostBlockMeasurement>>({})
  const [plans, setPlans] = useState<Record<string, PreparePlan>>({})
  const [runs, setRuns] = useState<Record<string, PrepareRunNote>>({})
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Why: measuring is the user's act (D-13). Nothing here measures on mount, on a timer, or after a
  // step reports started.
  const measure = useCallback(async (block: PrepareHostBlockSpec): Promise<void> => {
    setMeasurements((prev) => ({ ...prev, [block.key]: { phase: 'measuring' } }))
    setRuns((prev) => {
      const next = { ...prev }
      delete next[block.key]
      return next
    })
    let next: HostBlockMeasurement
    try {
      const outcome = await measureRequirementsForRuntimeTarget(block.target, block.repoId)
      next =
        outcome.status === 'measured'
          ? { phase: 'measured', result: outcome.result }
          : { phase: 'host-predates-probes' }
    } catch {
      next = { phase: 'failed' }
    }
    if (mounted.current) {
      setMeasurements((prev) => ({ ...prev, [block.key]: next }))
    }
  }, [])

  const run = useCallback(
    async (block: PrepareHostBlockSpec, step: PrepareStep, plan: PreparePlan): Promise<void> => {
      const outcome = await runPrepareStepForRuntimeTarget(block.target, block.repoId, {
        requirementId: step.requirementId,
        approvedContentHash: step.approvalHash,
        approvedHostKey: plan.hostKey
      })
      if (mounted.current) {
        setRuns((prev) => ({
          ...prev,
          [block.key]: { requirementId: step.requirementId, outcome }
        }))
      }
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next: Record<string, PreparePlan> = {}
      for (const block of blocks) {
        const state = measurements[block.key] ?? IDLE
        if (state.phase !== 'measured') {
          continue
        }
        const { result } = state
        next[block.key] = await buildPreparePlan(
          {
            contractSource: result.contractSource,
            hostKey: result.measurement.hostKey,
            requirements: result.requirements,
            measurement: result.measurement,
            approvals: readPrepareApprovals(trustedOrcaHooks, block.repoId),
            contract: result.contract
          },
          { sha256Hex: rendererPrepareSha256Hex }
        )
      }
      if (!cancelled) {
        setPlans(next)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [blocks, measurements, trustedOrcaHooks])

  return { measurements, plans, runs, measure, run }
}
