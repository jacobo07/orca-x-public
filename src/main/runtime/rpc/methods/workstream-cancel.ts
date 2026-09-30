import { z } from 'zod'
import {
  UWCP_CONTROL_CONTRACT,
  WORKSTREAM_AUTHORITY_UNAVAILABLE
} from '../../../../shared/execution-effect-refusals'
import { defineMethod, type RpcMethod } from '../core'

const WorkstreamCancelParams = z
  .object({ workstreamId: z.string().trim().min(1).max(256) })
  .strict()

// Why: Cancel belongs to the UWCP authority, not this runtime; until `uwcp.control/1` exists every
// request refuses (Cancel Workstream: ABSENT). The handler takes no ctx so it cannot reach a Stop.
export const WORKSTREAM_CANCEL_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'workstream.cancel',
    params: WorkstreamCancelParams,
    handler: () => {
      throw Object.assign(new Error(WORKSTREAM_AUTHORITY_UNAVAILABLE), {
        code: WORKSTREAM_AUTHORITY_UNAVAILABLE,
        data: { authority: UWCP_CONTROL_CONTRACT }
      })
    }
  })
]
