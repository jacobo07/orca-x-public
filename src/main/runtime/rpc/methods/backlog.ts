import { BACKLOG_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { BacklogHost } from '../../../backlog/backlog-host'
import { defineMethod, type RpcAnyMethod, type RpcContext } from '../core'
import {
  BacklogCaptureParams,
  BacklogGetParams,
  BacklogTransitionParams,
  BacklogUpdateParams
} from './backlog-params'

// Desktop, CLI and paired runtime clients share one intent ledger; mobile is not allowlisted.

function requireBacklogHost(runtime: RpcContext['runtime']): BacklogHost {
  const host = runtime.getBacklogHost()
  if (!host) {
    throw Object.assign(new Error(`This host does not serve ${BACKLOG_RUNTIME_CAPABILITY}`), {
      code: 'capability_unsupported'
    })
  }
  return host
}

export const BACKLOG_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'backlog.capture',
    params: BacklogCaptureParams,
    handler: async (params, { runtime }) => requireBacklogHost(runtime).capture(params)
  }),
  defineMethod({
    name: 'backlog.get',
    params: BacklogGetParams,
    handler: async (params, { runtime }) => requireBacklogHost(runtime).get(params.id)
  }),
  defineMethod({
    name: 'backlog.update',
    params: BacklogUpdateParams,
    handler: async (params, { runtime }) =>
      requireBacklogHost(runtime).update(params.id, params.patch)
  }),
  defineMethod({
    name: 'backlog.transition',
    params: BacklogTransitionParams,
    handler: async (params, { runtime }) =>
      requireBacklogHost(runtime).transition(params.id, {
        to: params.to,
        reason: params.reason ?? null
      })
  })
]
