import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { MissionBrief } from '../../../../shared/mission-brief-types'
import { ClaimValue } from '../resume-center/ClaimValue'
import { describeContradiction, describePhase, describeStageState } from './mission-brief-presentation'

/** Every phase of the same projection the brief shows; no second roadmap is kept. */
export function MissionBriefFullPathDialog({
  brief,
  open,
  onOpenChange
}: {
  brief: MissionBrief
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto scrollbar-sleek" data-testid="mission-brief-full-path">
        <DialogHeader>
          <DialogTitle>{translate('missionBrief.path.title', 'Full mission path')}</DialogTitle>
          <DialogDescription>
            {translate(
              'missionBrief.path.description',
              'Every phase from the workspace’s own roadmap, with GSD’s verification verdict for each.'
            )}
          </DialogDescription>
        </DialogHeader>
        <ol className="flex flex-col">
          {brief.stages.map((stage) => (
            <li
              key={stage.id}
              data-stage-state={stage.state}
              className={cn(
                'grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t border-border py-3 text-[13px]',
                stage.state === 'current' && 'rounded-md bg-muted/30 px-2'
              )}
            >
              <span className="font-medium">{describePhase(stage.id, stage.name)}</span>
              <ClaimValue testId="mission-brief-path-stage-state" className="text-[12px] text-muted-foreground">
                {describeStageState(stage.state)}
              </ClaimValue>
              {stage.goal ? <span className="text-muted-foreground">{stage.goal}</span> : <span />}
              <span className="text-[12px] text-muted-foreground">
                {stage.verification
                  ? translate('missionBrief.path.verification', 'Verification: {{status}}', { status: stage.verification })
                  : translate('missionBrief.path.noDirectory', 'No phase directory yet')}
              </span>
              {stage.dependsOn.length > 0 || stage.externalDependency ? (
                <span className="col-span-2 text-[12px] text-muted-foreground">
                  {translate('missionBrief.path.dependsOn', 'Depends on: {{list}}', {
                    list: [
                      ...stage.dependsOn.map((id) => describePhase(id, null)),
                      ...(stage.externalDependency ? [stage.externalDependency] : [])
                    ].join(', ')
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
        {brief.contradictions.length > 0 ? (
          <section className="mt-2 flex flex-col gap-1 text-[13px]">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              {translate('missionBrief.path.contradictions', 'Records that disagree')}
            </h3>
            {brief.contradictions.map((item, index) => (
              <p key={index}>{describeContradiction(item)}</p>
            ))}
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
