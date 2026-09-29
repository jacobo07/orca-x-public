import type { GsdInspect, GsdRoadmap } from './mission-brief-gsd-schema'
import type { MissionContradiction, MissionStage } from './mission-brief-types'
import { normalizePhaseId, parseDependsOn } from './mission-phase-dependencies'

/**
 * Mission stages from GSD's roadmap plus its verification verdicts. A stage is `proven` only on a
 * passed verification; a ticked roadmap box without one is `claimed`, and says so as a
 * contradiction, because GSD itself marks roadmap acceptance as non-authoritative.
 */

type PhaseEvidence = { verification: string; nextAction: string | null; accepted: boolean }

function evidenceById(inspect: GsdInspect | null): Map<string, PhaseEvidence> {
  const out = new Map<string, PhaseEvidence>()
  for (const phase of inspect?.phases ?? []) {
    const id = normalizePhaseId(phase.phase_id)
    if (id) {
      out.set(id, {
        verification: phase.verification?.status ?? 'unknown',
        nextAction: phase.verification?.next_action || null,
        accepted: phase.roadmap_acceptance?.checkbox === true
      })
    }
  }
  return out
}

export type StageProjection = {
  stages: MissionStage[]
  contradictions: MissionContradiction[]
  humanVerification: { stageId: string; nextAction: string }[]
}

export function projectStages(
  roadmap: GsdRoadmap | null,
  inspect: GsdInspect | null,
  activeId: string | null
): StageProjection {
  const evidence = evidenceById(inspect)
  const rows: { id: string; name: string; goal: string | null; dependsOn: string | null; ticked: boolean }[] =
    roadmap
      ? roadmap.phases.flatMap((phase) => {
          const id = normalizePhaseId(phase.number)
          return id
            ? [
                {
                  id,
                  name: phase.name,
                  goal: phase.goal ?? null,
                  dependsOn: phase.depends_on ?? null,
                  ticked: phase.roadmap_complete === true
                }
              ]
            : []
        })
      : [...evidence.keys()].map((id) => ({ id, name: id, goal: null, dependsOn: null, ticked: false }))

  const stages: MissionStage[] = rows.map((row) => {
    const phase = evidence.get(row.id)
    const verification = phase?.verification ?? null
    const claimed = row.ticked || phase?.accepted === true
    const deps = parseDependsOn(row.dependsOn)
    return {
      id: row.id,
      name: row.name,
      goal: row.goal,
      verification,
      dependsOn: deps.ids,
      externalDependency: deps.external,
      state:
        verification === 'passed'
          ? 'proven'
          : row.id === activeId
            ? 'current'
            : claimed
              ? 'claimed'
              : 'future'
    }
  })

  const byId = new Map(stages.map((stage) => [stage.id, stage]))
  const contradictions: MissionContradiction[] = []
  for (const stage of stages) {
    if (stage.state !== 'claimed') {
      continue
    }
    contradictions.push({
      kind: 'claimed-without-verification',
      stageId: stage.id,
      verification: stage.verification
    })
    for (const dependencyId of stage.dependsOn) {
      const dependency = byId.get(dependencyId)
      if (dependency && dependency.state !== 'proven' && dependency.state !== 'claimed') {
        contradictions.push({ kind: 'claimed-with-open-dependency', stageId: stage.id, dependencyId })
      }
    }
  }

  const humanVerification = [...evidence.entries()].flatMap(([stageId, phase]) =>
    phase.verification === 'human_needed' && phase.nextAction
      ? [{ stageId, nextAction: phase.nextAction }]
      : []
  )
  return { stages, contradictions, humanVerification }
}
