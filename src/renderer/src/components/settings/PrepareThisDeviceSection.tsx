import React, { useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { PreparePlan, PrepareStep } from '../../../../shared/environment-prepare-plan'
import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import {
  presentPrepareRefusal,
  presentRequirementReason,
  presentRequirementState,
  type EnvironmentRequirementTone
} from './environment-requirement-presentation'
import { PrepareStepApprovalDialog } from './PrepareStepApprovalDialog'
import { compareContractSources } from './prepare-contract-comparison'
import type { PrepareHostBlockSpec } from './prepare-host-blocks'
import { usePrepareDeviceMeasurements } from './use-prepare-device-measurements'
import { usePrepareHostBlocks } from './use-prepare-host-blocks'

// Why: the tone is the presenter's decision; this surface only maps it to a class.
const PREPARE_REQUIREMENT_TONE_CLASS: Record<EnvironmentRequirementTone, string> = {
  success: 'text-[var(--status-success)]',
  attention: 'text-[var(--status-warning)]',
  danger: 'text-[var(--status-error)]',
  neutral: 'text-muted-foreground'
}

type PendingApproval = { block: PrepareHostBlockSpec; step: PrepareStep; plan: PreparePlan }

type PrepareThisDeviceSectionProps = {
  repo: Repo
  selectedProjectSetupId?: string
}

export function PrepareThisDeviceSection({
  repo,
  selectedProjectSetupId
}: PrepareThisDeviceSectionProps): React.JSX.Element {
  const blocks = usePrepareHostBlocks(repo, selectedProjectSetupId)
  const trustedOrcaHooks = useAppStore((state) => state.trustedOrcaHooks)
  const approvePrepareStep = useAppStore((state) => state.approvePrepareStep)
  const { measurements, plans, runs, measure, run } = usePrepareDeviceMeasurements(
    blocks,
    trustedOrcaHooks
  )
  const [pending, setPending] = useState<PendingApproval | null>(null)

  const differs = useMemo(
    () =>
      compareContractSources(
        blocks.flatMap((block) => {
          const state = measurements[block.key]
          return state?.phase === 'measured'
            ? [
                {
                  hostKey: state.result.measurement.hostKey,
                  contract: state.result.contract,
                  contentHash: state.result.contractSource?.contentHash
                }
              ]
            : []
        })
      ),
    [blocks, measurements]
  )

  const renderRows = (block: PrepareHostBlockSpec, plan: PreparePlan): React.JSX.Element => {
    if (plan.contractVerdict) {
      const { state, reason } = plan.contractVerdict
      const presented = presentRequirementState(state)
      return (
        <div
          data-requirement-id="orca.yaml"
          data-requirement-state={state}
          data-requirement-reason={reason}
          className="px-3 py-2 text-xs"
        >
          <span className={cn('font-medium', PREPARE_REQUIREMENT_TONE_CLASS[presented.tone])}>
            {presented.label}
          </span>{' '}
          <span className="text-muted-foreground">{presentRequirementReason(reason)}</span>
        </div>
      )
    }
    if (plan.rows.length === 0) {
      return (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.PrepareThisDeviceSection.noRequirements',
            'No requirements declared'
          )}
        </p>
      )
    }
    return (
      <ul className="divide-y divide-border">
        {plan.rows.map((row) => {
          const presented = presentRequirementState(row.verdict.state)
          const step = plan.steps.find((candidate) => candidate.requirementId === row.id)
          const canRun = step && (row.verdict.reason === 'prepare-unapproved' || step.runnable)
          return (
            <li
              key={row.id}
              data-requirement-id={row.id}
              data-requirement-state={row.verdict.state}
              data-requirement-reason={row.verdict.reason}
              className="flex items-start gap-3 px-3 py-2"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  <span
                    className={cn('font-medium', PREPARE_REQUIREMENT_TONE_CLASS[presented.tone])}
                  >
                    {presented.label}
                  </span>
                  <span className="truncate font-mono">{row.id}</span>
                  <span className="text-muted-foreground">{row.kind}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {presentRequirementReason(row.verdict.reason)}
                  {row.verdict.evidence?.version ? ` (${row.verdict.evidence.version})` : ''}
                </p>
              </div>
              {canRun ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-prepare-run={row.id}
                  onClick={() => setPending({ block, step, plan })}
                >
                  {translate(
                    'auto.components.settings.PrepareThisDeviceSection.run',
                    'Review and run'
                  )}
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
    )
  }

  const renderRunNote = (block: PrepareHostBlockSpec): React.JSX.Element | null => {
    const note = runs[block.key]
    if (!note) {
      return null
    }
    if (note.outcome.status === 'started') {
      return (
        <p
          data-prepare-step-started={note.requirementId}
          className="px-3 py-2 text-xs text-muted-foreground"
        >
          {translate(
            'auto.components.settings.PrepareThisDeviceSection.started',
            'Step started in a terminal. Measure again after it finishes.'
          )}
        </p>
      )
    }
    if (note.outcome.status === 'unknown') {
      return (
        <p
          data-prepare-step-unknown={note.requirementId}
          role="alert"
          className="px-3 py-2 text-xs text-muted-foreground"
        >
          {translate(
            'auto.components.settings.PrepareThisDeviceSection.unknown',
            'Orca stopped waiting for that host, so the step may have started. Check its terminals before running it again, then measure again.'
          )}
        </p>
      )
    }
    return (
      <p
        data-prepare-refusal={note.outcome.reason}
        role="alert"
        className="px-3 py-2 text-xs text-muted-foreground"
      >
        {translate(
          'auto.components.settings.PrepareThisDeviceSection.notStarted',
          'Not started: {{value0}}',
          {
            value0: presentPrepareRefusal(note.outcome.reason)
          }
        )}
      </p>
    )
  }

  const renderBlockBody = (block: PrepareHostBlockSpec): React.JSX.Element | null => {
    const state = measurements[block.key] ?? { phase: 'idle' as const }
    if (state.phase === 'failed') {
      return (
        <p data-prepare-measure-failed="" className="px-3 py-2 text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.PrepareThisDeviceSection.failed',
            'Orca could not measure this host. Nothing was changed.'
          )}
        </p>
      )
    }
    if (state.phase === 'host-predates-probes') {
      return (
        <p data-prepare-host-predates="" className="px-3 py-2 text-xs text-muted-foreground">
          {presentRequirementReason('host-predates-probes')}
        </p>
      )
    }
    const plan = plans[block.key]
    if (state.phase !== 'measured' || !plan) {
      return null
    }
    const otherHosts = differs.get(plan.hostKey)
    const source = plan.contractSource
    return (
      <div>
        <p data-prepare-contract-source="" className="px-3 pt-2 text-[11px] text-muted-foreground">
          {source
            ? translate(
                'auto.components.settings.PrepareThisDeviceSection.header',
                'Requirements from orca.yaml on {{value0}} ({{value1}}), measured on {{value2}} at {{value3}}',
                {
                  value0: source.hostKey,
                  value1: source.contentHash.slice(0, 8),
                  value2: plan.hostKey,
                  value3: new Date(plan.measuredAt).toLocaleTimeString()
                }
              )
            : translate(
                'auto.components.settings.PrepareThisDeviceSection.noContract',
                'No orca.yaml was read on {{value0}}',
                { value0: plan.hostKey }
              )}
        </p>
        {otherHosts ? (
          <p
            data-contract-differs={otherHosts.join(',')}
            className="px-3 pt-1 text-[11px] text-muted-foreground"
          >
            {translate(
              'auto.components.settings.PrepareThisDeviceSection.differs',
              'Contract differs on {{value0}}',
              { value0: otherHosts.join(', ') }
            )}
          </p>
        ) : null}
        {renderRows(block, plan)}
        {renderRunNote(block)}
      </div>
    )
  }

  return (
    <section data-prepare-device-section="" className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">
          {translate(
            'auto.components.settings.PrepareThisDeviceSection.title',
            'Prepare this device'
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.PrepareThisDeviceSection.description',
            'Requirements declared in orca.yaml, measured on each host that has this project.'
          )}
        </p>
      </div>
      {blocks.map((block) => {
        const state = measurements[block.key]
        return (
          <div
            key={block.key}
            data-prepare-host-block={block.key}
            className="divide-y divide-border rounded-md border border-border"
          >
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="truncate text-sm font-medium">{block.hostLabel}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-prepare-measure={block.key}
                disabled={state?.phase === 'measuring'}
                onClick={() => void measure(block)}
              >
                {state?.phase === 'measuring'
                  ? translate(
                      'auto.components.settings.PrepareThisDeviceSection.measuring',
                      'Measuring…'
                    )
                  : state && state.phase !== 'idle'
                    ? translate(
                        'auto.components.settings.PrepareThisDeviceSection.measureAgain',
                        'Measure again'
                      )
                    : translate(
                        'auto.components.settings.PrepareThisDeviceSection.measure',
                        'Measure'
                      )}
              </Button>
            </div>
            {renderBlockBody(block)}
          </div>
        )
      })}
      {pending ? (
        <PrepareStepApprovalDialog
          open
          repoName={repo.displayName}
          hostLabel={`${pending.block.hostLabel} (${pending.plan.hostKey})`}
          step={{
            requirementId: pending.step.requirementId,
            bytes: pending.step.bytes,
            labels: pending.step.labels
          }}
          onApprove={() =>
            approvePrepareStep(
              pending.block.repoId,
              pending.step.requirementId,
              pending.step.approvalHash
            )
          }
          onApproved={() => {
            const { block, step, plan } = pending
            setPending(null)
            void run(block, step, plan)
          }}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </section>
  )
}
