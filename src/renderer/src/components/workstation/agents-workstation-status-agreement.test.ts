// Agents and Workstation draw the same running session from the same host evidence. This drives both
// real projections from one host list and one dashboard snapshot, and compares what each would draw —
// never "both use StatusMark", which a divergent derivation would also satisfy.

import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { StatusState } from '@/components/ui/status-mark'
import { hostReachabilityStatus, type HostReachability } from '@/lib/host-reachability'
import { describeRunningSessionLiveness } from '../conversations/running-session-presentation'
import {
  indexHostReachability,
  projectRunningSessions
} from '../conversations/workspace-running-sessions'
import type { SidebarHostOption } from '../sidebar/sidebar-host-options'
import { buildWorkstation } from './workstation-projection'

function host(o: Partial<SidebarHostOption> & Pick<SidebarHostOption, 'id'>): SidebarHostOption {
  return {
    label: o.id,
    detail: '',
    kind: 'ssh',
    health: 'disconnected',
    presence: 'configured',
    ...o
  }
}

// One host per reachability the registry can actually produce, plus one it no longer knows.
const HOSTS: { host: SidebarHostOption | null; id: ExecutionHostId; expect: HostReachability }[] = [
  {
    id: LOCAL_EXECUTION_HOST_ID,
    host: host({ id: LOCAL_EXECUTION_HOST_ID, kind: 'local', health: 'local' }),
    expect: 'this-machine'
  },
  {
    id: 'ssh:up' as ExecutionHostId,
    host: host({
      id: 'ssh:up' as ExecutionHostId,
      health: 'available',
      connectionStatus: 'connected'
    }),
    expect: 'reachable'
  },
  {
    id: 'ssh:never' as ExecutionHostId,
    host: host({ id: 'ssh:never' as ExecutionHostId }),
    expect: 'unknown'
  },
  {
    id: 'ssh:refused' as ExecutionHostId,
    host: host({
      id: 'ssh:refused' as ExecutionHostId,
      health: 'error',
      connectionStatus: 'auth-failed'
    }),
    expect: 'failed'
  },
  {
    id: 'ssh:dialing' as ExecutionHostId,
    host: host({
      id: 'ssh:dialing' as ExecutionHostId,
      health: 'connecting',
      connectionStatus: 'connecting'
    }),
    expect: 'connecting'
  },
  {
    id: 'runtime:old' as ExecutionHostId,
    host: host({ id: 'runtime:old' as ExecutionHostId, kind: 'runtime', health: 'blocked' }),
    expect: 'blocked'
  },
  { id: 'ssh:gone' as ExecutionHostId, host: null, expect: 'unknown' }
]

const BUCKETS: DashboardCard['bucket'][] = ['working', 'attention', 'done', 'idle']

// The meaning both surfaces must agree on: an observed host shows the agent's own state; any other
// host leaves the agent UNKNOWN — a failed host is CRITICAL on the host, never on the agent.
const OBSERVED: Record<DashboardCard['bucket'], StatusState> = {
  working: 'HEALTHY',
  attention: 'NEEDS_APPROVAL',
  done: 'IDLE',
  idle: 'IDLE'
}

function card(hostId: ExecutionHostId, bucket: DashboardCard['bucket']): DashboardCard {
  const key = `${hostId}|${bucket}`
  return {
    paneKey: key,
    ptyId: key,
    agentType: 'claude',
    bucket,
    dotState: bucket,
    task: key,
    repoId: 'repo',
    worktreeId: 'wt',
    tabId: key,
    leafId: null,
    repoName: 'orca',
    worktreeName: 'main',
    startedAt: 1,
    finishedAt: null,
    stateChangedAt: 1,
    unseen: false,
    executionHostId: hostId
  } as DashboardCard
}

const hostOptions = HOSTS.flatMap((h) => (h.host ? [h.host] : []))
const cards = HOSTS.flatMap((h) => BUCKETS.map((bucket) => card(h.id, bucket)))
const sessions = projectRunningSessions(cards, indexHostReachability(hostOptions), new Map())
const { nodes } = buildWorkstation({ hosts: hostOptions, setups: [], projects: [], sessions })

const cases = HOSTS.flatMap((h) => BUCKETS.map((bucket) => ({ ...h, bucket })))

describe('Agents and Workstation agree on every running session', () => {
  it('covers every host reachability the registry can produce', () => {
    expect(new Set(HOSTS.map((h) => h.expect)).size).toBe(6)
    expect(sessions).toHaveLength(cases.length)
  })

  it.each(cases)('$id / $bucket', ({ id, bucket, expect: reachability }) => {
    const session = sessions.find((s) => s.paneKey === `${id}|${bucket}`)!
    const node = nodes.find((n) => n.hostId === id)!
    const agent = node.agents.find((a) => a.paneKey === session.paneKey)!
    const vouched = reachability === 'this-machine' || reachability === 'reachable'
    const expected: StatusState = vouched ? OBSERVED[bucket] : 'UNKNOWN'

    // The host: one reading, one state, on both surfaces.
    expect(node.reachability).toBe(reachability)
    expect(session.hostReachability).toBe(reachability)
    expect(hostReachabilityStatus(session.hostReachability)).toBe(
      hostReachabilityStatus(node.reachability)
    )
    // The agent: what Agents draws === what Workstation draws === the meaning above.
    expect(describeRunningSessionLiveness(session).status).toBe(expected)
    expect(agent.status).toBe(expected)
  })

  it('a failed host is CRITICAL on the host and UNKNOWN on its agents', () => {
    const node = nodes.find((n) => n.hostId === 'ssh:refused')!
    expect(hostReachabilityStatus(node.reachability)).toBe('CRITICAL')
    expect(node.agents.map((a) => a.status)).toEqual(BUCKETS.map(() => 'UNKNOWN'))
  })
})
