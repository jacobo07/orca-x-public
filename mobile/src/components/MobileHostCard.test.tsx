import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionVerdict } from '../transport/connection-health'
import type { HomeHostStatusSnapshot } from '../transport/home-host-status-fetch'
import { MIN_COMPATIBLE_DESKTOP_VERSION } from '../transport/protocol-version'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, HostCredentialStatus, HostProfile } from '../transport/types'
import {
  markHomeWorktreeCatalogUnavailable,
  type HostWorktreeInfo
} from '../worktree/home-worktree-info'
import type { HostCardWakeAttempt, HostCardWakeInputs } from './host-availability-presentation'
import { MobileHostCard } from './MobileHostCard'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Monitor: 'Monitor',
  MoreVertical: 'MoreVertical',
  Power: 'Power'
}))
vi.mock('./StatusDot', () => ({ StatusDot: 'StatusDot' }))

const host: HostProfile = {
  id: 'host-1',
  name: 'Studio',
  endpoint: 'ws://studio.local:8765',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 0
}
const verdict: ConnectionVerdict = { kind: 'normal', label: 'Connected' }
const loaded: HostWorktreeInfo = {
  hostId: 'host-1',
  totalWorktrees: 12,
  activeCount: 2,
  lastActiveWorktree: null,
  countsProvenAt: Date.now()
}

describe('MobileHostCard', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function renderCard(
    worktreeInfo: HostWorktreeInfo | undefined,
    overrides?: {
      state?: ConnectionState
      verdict?: ConnectionVerdict
      path?: MobileConnectionPath
      credentialStatus?: HostCredentialStatus
    }
  ): Promise<string[]> {
    await act(async () => {
      renderer = create(
        createElement(MobileHostCard, {
          host,
          state: overrides?.state ?? 'connected',
          verdict: overrides?.verdict ?? verdict,
          path: overrides?.path ?? 'lan',
          credentialStatus: overrides?.credentialStatus,
          worktreeInfo,
          onPress: () => {},
          onLongPress: () => {},
          onOpenActions: () => {}
        })
      )
    })
    return renderer!.root
      .findAllByType('Text')
      .flatMap((node) => node.children.filter((child) => typeof child === 'string'))
  }

  it('renders the counts the host proved', async () => {
    expect(await renderCard(loaded)).toContain('12 worktrees · 2 active')
  })

  it('keeps rendering the last proven counts after a failed refresh', async () => {
    // The regression this card shipped once: the caller dropped the counts the
    // failure path deliberately preserved.
    expect(await renderCard(markHomeWorktreeCatalogUnavailable(loaded, 'host-1'))).toContain(
      'Last known: 12 worktrees · 2 active'
    )
  })

  it('never asserts a count for a catalog that failed with nothing proven', async () => {
    expect(await renderCard(markHomeWorktreeCatalogUnavailable(undefined, 'host-1'))).toContain(
      'Worktree list unavailable'
    )
  })

  it('names the relay while the dial is still in flight', async () => {
    const lines = await renderCard(undefined, {
      state: 'connecting',
      verdict: { kind: 'normal', label: 'Connecting…' },
      path: 'relay'
    })

    expect(lines).toContain('Connecting…')
    expect(lines).toContain(' · Orca Relay')
  })

  it('names the relay while a failed direct dial is still retrying', async () => {
    const lines = await renderCard(undefined, {
      state: 'reconnecting',
      verdict: { kind: 'normal', label: 'Reconnecting…' },
      path: 'relay'
    })

    expect(lines).toContain(' · Orca Relay')
  })

  it('leaves an idle disconnected host unlabelled', async () => {
    const lines = await renderCard(undefined, {
      state: 'disconnected',
      verdict: { kind: 'normal', label: 'Disconnected' },
      path: 'relay'
    })

    expect(lines).not.toContain(' · Orca Relay')
  })

  it('does not guess a direct path before the dial resolves', async () => {
    const lines = await renderCard(undefined, {
      state: 'connecting',
      verdict: { kind: 'normal', label: 'Connecting…' },
      path: 'lan'
    })

    expect(lines).not.toContain(' · Direct · LAN')
  })

  it('shows no worktree line before the first read lands', async () => {
    const lines = await renderCard(undefined)

    expect(lines).not.toContain('0 worktrees')
    expect(lines).not.toContain('Worktree list unavailable')
  })

  it('offers re-pairing when the credential is missing', async () => {
    const lines = await renderCard(loaded, {
      state: 'connected',
      verdict: { kind: 'auth-failed', label: 'Pairing invalid' },
      credentialStatus: 'missing'
    })

    expect(lines).toContain('Pairing invalid')
    expect(lines).toContain('Tap to re-pair with your desktop')
    expect(lines).not.toContain('12 worktrees · 2 active')
  })

  it('offers a retry without declaring a transient read failure invalid', async () => {
    const lines = await renderCard(undefined, {
      state: 'disconnected',
      verdict: { kind: 'normal', label: 'Disconnected' },
      credentialStatus: 'temporarily-unavailable'
    })

    expect(lines).toContain('Pairing temporarily unavailable')
    expect(lines).toContain('Unlock your phone, then tap to retry')
    expect(lines).not.toContain('Pairing invalid')
  })
})

const HOST_KEY = 'Yw3NKWbEM2aRElRIu7JbT_QSpJxzLbLIq8G4WBvXEN0'
const WOKEN_TEXT = /\b(?:woken|awake|on)\b/i

function boundWake(
  entry: Record<string, unknown> = {
    targetId: 'wt_0123456789ab',
    label: 'Studio',
    hostKey: HOST_KEY
  },
  attempt: HostCardWakeAttempt | null = null
): HostCardWakeInputs {
  return {
    hostKey: HOST_KEY,
    brokers: [
      {
        brokerHostId: 'host-broker',
        inputs: {
          broker: { connected: true, lastConnectedAt: 1000 },
          status: { observedAt: 1001, result: { capabilities: ['host.wake-broker.v1'] } },
          targets: { observedAt: 1002, targets: [entry] }
        }
      }
    ],
    attempt
  }
}

function sentAttempt(repliedAt: number | null): HostCardWakeAttempt {
  return {
    brokerHostId: 'host-broker',
    targetId: 'wt_0123456789ab',
    requestId: 'req-00000001',
    pressedAt: 5000,
    repliedAt,
    wakeId: repliedAt === null ? null : 'wake-1',
    brokerStages:
      repliedAt === null
        ? []
        : [
            { stage: 'requested', observedAt: 1, observer: 'broker' },
            { stage: 'authorized', observedAt: 2, observer: 'broker' },
            { stage: 'packet-sent', observedAt: 3, observer: 'broker' }
          ],
    refusalCode: null
  }
}

describe('MobileHostCard Wake control', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function renderWakeCard(props: {
    wake: HostCardWakeInputs
    onWake: () => void
    state?: ConnectionState
    statusSnapshot?: HomeHostStatusSnapshot
  }): Promise<ReactTestInstance> {
    await act(async () => {
      renderer = create(
        createElement(MobileHostCard, {
          host,
          state: props.state ?? 'disconnected',
          verdict:
            props.state === 'connected'
              ? { kind: 'normal', label: 'Connected' }
              : { kind: 'unreachable', label: 'Unreachable' },
          path: 'lan',
          lastConnectedAt: 900,
          statusSnapshot: props.statusSnapshot,
          wake: props.wake,
          onWake: props.onWake,
          onPress: () => {},
          onLongPress: () => {},
          onOpenActions: () => {}
        })
      )
    })
    return renderer!.root
  }

  function byTestID(root: ReactTestInstance, testID: string): ReactTestInstance[] {
    return root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID)
  }

  // findAll includes the node itself, so a Text node reads its own children.
  function textOf(node: ReactTestInstance): string {
    return node
      .findAll((child) => child.type === 'Text')
      .flatMap((child) => child.children.filter((part) => typeof part === 'string'))
      .join(' ')
  }

  it('draws one Wake control beside host-card-open for a bound route, and a press reaches onWake once', async () => {
    const onWake = vi.fn()
    const root = await renderWakeCard({ wake: boundWake(), onWake })

    const controls = byTestID(root, 'host-card-wake')
    expect(controls).toHaveLength(1)
    const [open] = byTestID(root, 'host-card-open')
    expect(byTestID(open, 'host-card-wake')).toHaveLength(0)
    expect(root.findAllByType('Pressable').map((node) => node.props.testID)).toEqual([
      'host-card-open',
      'host-card-wake',
      'host-card-actions'
    ])
    act(() => controls[0].props.onPress())
    expect(onWake).toHaveBeenCalledTimes(1)
  })

  it('draws no Wake control when the broker entry carries no hostKey (control without binding)', async () => {
    const root = await renderWakeCard({
      wake: boundWake({ targetId: 'wt_0123456789ab', label: 'Studio' }),
      onWake: vi.fn()
    })

    expect(byTestID(root, 'host-card-wake')).toHaveLength(0)
  })

  it('draws no Wake control when the host itself answered and reads awake', async () => {
    const root = await renderWakeCard({
      wake: boundWake(),
      onWake: vi.fn(),
      state: 'connected',
      statusSnapshot: {
        observedAt: 2000,
        result: { protocolVersion: MIN_COMPATIBLE_DESKTOP_VERSION, graphStatus: 'ready' }
      }
    })

    expect(byTestID(root, 'host-card-availability')[0].children).toEqual([
      'Awake · Orca runtime ready'
    ])
    expect(byTestID(root, 'host-card-wake')).toHaveLength(0)
  })

  it('keeps the control busy and disabled while the request is in flight', async () => {
    const root = await renderWakeCard({
      wake: boundWake(undefined, sentAttempt(null)),
      onWake: vi.fn()
    })

    const [control] = byTestID(root, 'host-card-wake')
    expect(control.props.disabled).toBe(true)
    expect(control.props.accessibilityState).toEqual({ busy: true, disabled: true })
    expect(byTestID(root, 'host-card-request-stage')).toHaveLength(0)
  })

  it('shows a packet sent as a broker stage and never as a woken host', async () => {
    const root = await renderWakeCard({
      wake: boundWake(undefined, sentAttempt(5100)),
      onWake: vi.fn()
    })

    const [stage] = byTestID(root, 'host-card-request-stage')
    expect(stage.children).toEqual(['Wake packet sent'])
    const [control] = byTestID(root, 'host-card-wake')
    expect(textOf(control)).toBe('Wake')
    expect(control.props.disabled).toBe(false)
    for (const text of [textOf(stage), textOf(control)]) {
      expect(text).not.toMatch(WOKEN_TEXT)
    }
    const [open] = byTestID(root, 'host-card-open')
    expect(open.props.accessibilityLabel).toContain('Wake packet sent')
  })
})
