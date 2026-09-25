import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalString, requiredString } from '../schemas'
import { resolveRunScope } from './orchestration-run-scope'
import { requestReview } from '../../orchestration/review-request'
import { describeReview } from '../../orchestration/review-view'

// Why no producer agent/provider here: Orca reads them from the producer task's recorded result,
// so a caller cannot make a review look independent by naming a different builder.
const ReviewRequestParams = z.object({
  reviewerAgent: requiredString('Missing --reviewer-agent'),
  project: requiredString('Missing --project'),
  worktree: requiredString('Missing --worktree'),
  revision: OptionalString,
  producerTask: OptionalString,
  independent: OptionalBoolean,
  callerTerminalHandle: OptionalString,
  run: OptionalString
})

const ReviewShowParams = z.object({
  id: requiredString('Missing --id')
})

export const ORCHESTRATION_REVIEW_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.reviewRequest',
    params: ReviewRequestParams,
    handler: async (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      if (!isAbsolute(params.worktree)) {
        throw new Error('Invalid --worktree: must be an absolute path')
      }
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.callerTerminalHandle,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      const outcome = await requestReview(db, {
        runId: run.id,
        reviewerAgentId: params.reviewerAgent,
        projectId: params.project,
        worktreePath: params.worktree,
        ...(params.revision ? { revision: params.revision } : {}),
        ...(params.producerTask ? { producerTaskId: params.producerTask } : {}),
        policy: params.independent ? 'independent' : 'any'
      })
      if (outcome.outcome === 'refused') {
        throw new Error(`Review refused (${outcome.reason}): ${outcome.detail}`)
      }
      return { review: outcome.review, task: outcome.task }
    }
  }),

  defineMethod({
    name: 'orchestration.reviewShow',
    params: ReviewShowParams,
    handler: async (params, { runtime }) => {
      const review = runtime.getOrchestrationDb().reviews().get(params.id)
      if (!review) {
        throw new Error(`No review ${params.id}`)
      }
      return { review, ...(await describeReview(review)) }
    }
  })
]
