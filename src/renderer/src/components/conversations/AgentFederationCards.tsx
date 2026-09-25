import { ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { AgentApprovalView } from '../../../../shared/agent-federation-view'

import { ContextCard, ContextRow } from './AgentContextRail'
import {
  describeApproval,
  describeApprovalBlocker,
  describeCurrency,
  describeIndependence,
  describeReviewOutcome,
  type FederationFact,
  type FederationTone
} from './agent-federation-presentation'
import { useAgentFederation } from './use-agent-federation'

const TONE_TEXT: Record<FederationTone, string> = {
  ready: 'text-[var(--status-success)]',
  caution: 'text-foreground',
  refused: 'text-destructive',
  neutral: 'text-foreground'
}

function FactText({ fact }: { fact: FederationFact }): React.JSX.Element {
  return <span className={cn(TONE_TEXT[fact.tone])}>{fact.label}</span>
}

const shortRevision = (revision: string): string => revision.slice(0, 12)

function ApprovalRow({
  approval,
  onDecide,
  onRebind
}: {
  approval: AgentApprovalView
  onDecide: (decision: 'approved' | 'rejected') => Promise<void>
  onRebind: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const run = (action: () => Promise<void>) => () => {
    setBusy(true)
    void action().finally(() => setBusy(false))
  }
  const blocker = describeApprovalBlocker(approval)
  const open = approval.decision === 'pending' || approval.decision === 'stale'
  const moved = !approval.readiness.ready && approval.readiness.blocker === 'subject-moved'
  return (
    <ContextRow term={shortRevision(approval.revision)} testId="agent-approval" state={approval.decision}>
      <span className="flex flex-col gap-1">
        <span className="text-muted-foreground">{approval.question}</span>
        <FactText fact={describeApproval(approval)} />
        {open && blocker ? <span className="text-muted-foreground">{blocker}</span> : null}
        {open ? (
          <span className="flex flex-wrap gap-1">
            {moved ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={run(onRebind)}>
                {translate('workspace.federation.useCurrent', 'Use current commit')}
              </Button>
            ) : (
              <Button size="sm" disabled={busy || !approval.readiness.ready} onClick={run(() => onDecide('approved'))}>
                {translate('workspace.federation.approve', 'Approve this commit')}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={run(() => onDecide('rejected'))}>
              {translate('workspace.federation.reject', 'Reject')}
            </Button>
          </span>
        ) : null}
      </span>
    </ContextRow>
  )
}

/**
 * The agent's reviews and the approvals waiting on a person. Every row is main's answer, judged
 * against git when it was read; approving sends back the exact revision shown, and main re-checks
 * it — a commit that moved since the row was drawn is refused, not approved.
 */
export function AgentFederationCards({ agentId }: { agentId: string | null }): React.JSX.Element | null {
  const { lookup, decide, rebind } = useAgentFederation(agentId)
  const [notice, setNotice] = useState<string | null>(null)
  if (!agentId) {
    return null
  }
  const view = lookup?.status === 'loaded' ? lookup.view : null
  const problem =
    lookup?.status === 'failed' ? lookup.reason : view?.outcome === 'unavailable' ? view.reason : null
  const loaded = view?.outcome === 'loaded' ? view : null
  const iconClass = 'size-4 text-muted-foreground'

  return (
    <ContextCard
      icon={<ShieldCheck className={iconClass} aria-hidden />}
      title={translate('workspace.federation.title', 'Reviews and approvals')}
      testId="agent-context-federation"
    >
      {problem !== null ? (
        <ContextRow term="—" testId="agent-federation-unavailable">
          <span className="text-destructive">{problem}</span>
        </ContextRow>
      ) : !loaded ? (
        <ContextRow term="—" testId="agent-federation-reading">
          {translate('workspace.context.reading', 'Reading…')}
        </ContextRow>
      ) : loaded.reviews.length === 0 && loaded.approvals.length === 0 ? (
        <ContextRow term="—" testId="agent-federation-none">
          <span className="text-muted-foreground">
            {translate('workspace.federation.none', 'No reviews or approvals for this agent')}
          </span>
        </ContextRow>
      ) : (
        <>
          {loaded.approvals.map((approval) => (
            <ApprovalRow
              key={approval.gateId}
              approval={approval}
              onDecide={async (decision) => {
                const outcome = await decide({
                  gateId: approval.gateId,
                  decision,
                  revision: approval.revision,
                  patchHash: approval.patchHash
                })
                setNotice(outcome.outcome === 'refused' ? outcome.detail : null)
              }}
              onRebind={async () => {
                const outcome = await rebind(approval.gateId)
                setNotice(outcome.outcome === 'refused' ? outcome.detail : null)
              }}
            />
          ))}
          {loaded.reviews.map((review) => (
            <ContextRow key={review.id} term={shortRevision(review.revision)} testId="agent-review" state={review.status}>
              <span className="flex flex-col">
                <FactText fact={describeReviewOutcome(review)} />
                <FactText fact={describeIndependence(review)} />
                <FactText fact={describeCurrency(review)} />
                {review.findings?.kind === 'structured'
                  ? review.findings.findings.map((finding, index) => (
                      <span key={index} className="text-muted-foreground">
                        [{finding.severity}] {finding.summary}
                      </span>
                    ))
                  : null}
              </span>
            </ContextRow>
          ))}
        </>
      )}
      {notice ? (
        <ContextRow term="!" testId="agent-federation-notice">
          <span className="text-destructive" role="alert">
            {notice}
          </span>
        </ContextRow>
      ) : null}
    </ContextCard>
  )
}
