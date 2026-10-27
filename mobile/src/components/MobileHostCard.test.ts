import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { colors } from '../theme/mobile-theme'
import type { ConnectionVerdict } from '../transport/connection-health'
import type { HomeHostStatusSnapshot } from '../transport/home-host-status-fetch'
import { MIN_COMPATIBLE_DESKTOP_VERSION } from '../transport/protocol-version'
import type { ConnectionState, HostCredentialStatus } from '../transport/types'
import { MobileHostCard } from './MobileHostCard'

const serveStatusResult = {
  protocolVersion: MIN_COMPATIBLE_DESKTOP_VERSION,
  graphStatus: 'ready',
  desktopWindowStatus: 'openable',
  capabilities: ['host.availability.v1'],
  hostAvailability: {
    schema: 1,
    processKind: 'serve',
    observedAt: 1500,
    capabilities: {
      'can-relay': {
        value: 'supported',
        reason: 'relay_paired',
        evidence: { kind: 'relay-reported', observedAt: 1500 }
      }
    }
  }
}

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Monitor: 'Monitor',
  MoreVertical: 'MoreVertical'
}))

vi.mock('./StatusDot', () => ({
  StatusDot: 'StatusDot'
}))

function suppressRendererDeprecation() {
  return vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
      throw new Error(String(args[0]))
    }
  })
}

describe('MobileHostCard', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('keeps host navigation and actions as separate accessible controls', async () => {
    const onPress = vi.fn()
    const onLongPress = vi.fn()
    const onOpenActions = vi.fn()
    const consoleError = suppressRendererDeprecation()
    await act(async () => {
      renderer = create(
        createElement(MobileHostCard, {
          host: {
            id: 'desk',
            name: 'Desk',
            endpoint: 'ws://192.168.1.2:6768',
            deviceToken: 'token',
            publicKeyB64: 'key',
            lastConnected: 1
          },
          state: 'disconnected',
          verdict: { kind: 'normal', label: 'Disconnected' },
          path: 'lan',
          onPress,
          onLongPress,
          onOpenActions
        })
      )
    })
    consoleError.mockRestore()

    const buttons = renderer.root.findAllByType('Pressable')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].props.accessibilityRole).toBe('button')
    expect(buttons[0].props.accessibilityLabel).toBe(
      'Open Desk, Disconnected, Power unknown, Orca unknown, Capabilities unknown'
    )
    expect(buttons.map((button) => button.props.testID)).toEqual([
      'host-card-open',
      'host-card-actions'
    ])
    expect(buttons[1].props.accessibilityRole).toBe('button')
    expect(buttons[1].props.accessibilityLabel).toBe('Actions for Desk')
    expect(buttons[1].props.hitSlop).toBe(8)
    expect(buttons[1].props.style({ pressed: false })[0]).toMatchObject({ width: 40, height: 40 })
    expect(renderer.root.findAllByType('MoreVertical')).toHaveLength(1)
    expect(renderer.root.findAllByType('ChevronRight')).toHaveLength(0)

    act(() => buttons[1].props.onPress())
    expect(onOpenActions).toHaveBeenCalledOnce()
    expect(onPress).not.toHaveBeenCalled()

    act(() => buttons[0].props.onPress())
    act(() => buttons[0].props.onLongPress())
    expect(onPress).toHaveBeenCalledOnce()
    expect(onLongPress).toHaveBeenCalledOnce()
  })

  it('announces the connection path without the visual separator', async () => {
    const consoleError = suppressRendererDeprecation()
    await act(async () => {
      renderer = create(
        createElement(MobileHostCard, {
          host: {
            id: 'desk',
            name: 'Desk',
            endpoint: 'ws://192.168.1.2:6768',
            deviceToken: 'token',
            publicKeyB64: 'key',
            lastConnected: 1
          },
          state: 'connected',
          verdict: { kind: 'normal', label: 'Connected' },
          path: 'tailscale',
          worktreeInfo: {
            hostId: 'desk',
            totalWorktrees: 3,
            activeCount: 2,
            lastActiveWorktree: null,
            countsProvenAt: Date.now()
          },
          onPress: vi.fn(),
          onLongPress: vi.fn(),
          onOpenActions: vi.fn()
        })
      )
    })
    consoleError.mockRestore()

    const navigationButton = renderer.root.findAllByType('Pressable')[0]
    expect(navigationButton.props.accessibilityLabel).toBe(
      'Open Desk, Connected, Direct via Tailscale, 3 worktrees, 2 active, Power unknown, Orca unknown, Capabilities unknown'
    )
  })

  it('preserves the connected worktree-catalog failure state', async () => {
    const consoleError = suppressRendererDeprecation()
    await act(async () => {
      renderer = create(
        createElement(MobileHostCard, {
          host: {
            id: 'desk',
            name: 'Desk',
            endpoint: 'ws://192.168.1.2:6768',
            deviceToken: 'token',
            publicKeyB64: 'key',
            lastConnected: 1
          },
          state: 'connected',
          verdict: { kind: 'normal', label: 'Connected' },
          path: 'relay',
          worktreeInfo: {
            hostId: 'desk',
            totalWorktrees: 0,
            activeCount: 0,
            lastActiveWorktree: null,
            catalogUnavailable: true
          },
          onPress: vi.fn(),
          onLongPress: vi.fn(),
          onOpenActions: vi.fn()
        })
      )
    })
    consoleError.mockRestore()

    const navigationButton = renderer.root.findAllByType('Pressable')[0]
    expect(navigationButton.props.accessibilityLabel).toBe(
      'Open Desk, Connected, Orca Relay, Worktree list unavailable, Power unknown, Orca unknown, Capabilities unknown'
    )
    expect(
      renderer.root
        .findAllByType('Text')
        .some((node) => node.children.includes('Worktree list unavailable'))
    ).toBe(true)
  })

  it('includes visible offline recovery guidance in the navigation label', async () => {
    const consoleError = suppressRendererDeprecation()
    await act(async () => {
      renderer = create(
        createElement(MobileHostCard, {
          host: {
            id: 'desk',
            name: 'Desk',
            endpoint: 'ws://192.168.1.2:6768',
            deviceToken: 'token',
            publicKeyB64: 'key',
            lastConnected: 1
          },
          state: 'reconnecting',
          verdict: {
            kind: 'unreachable',
            label: "Can't reach desktop",
            reason: 'never-connected'
          },
          path: 'lan',
          onPress: vi.fn(),
          onLongPress: vi.fn(),
          onOpenActions: vi.fn()
        })
      )
    })
    consoleError.mockRestore()

    const navigationButton = renderer.root.findAllByType('Pressable')[0]
    expect(navigationButton.props.accessibilityLabel).toBe(
      "Open Desk, Can't reach desktop, Power unknown, Orca unknown, Capabilities unknown, Update desktop Orca X and sign in to connect from anywhere"
    )
  })

  it('projects a current serve-host status answer onto the availability and capability lines', async () => {
    const consoleError = suppressRendererDeprecation()
    await act(async () => {
      renderer = create(
        createElement(MobileHostCard, {
          host: {
            id: 'desk',
            name: 'Desk',
            endpoint: 'ws://192.168.1.2:6768',
            deviceToken: 'token',
            publicKeyB64: 'key',
            lastConnected: 1
          },
          state: 'connected',
          verdict: { kind: 'normal', label: 'Connected' },
          path: 'lan',
          lastConnectedAt: 1000,
          statusSnapshot: { observedAt: 2000, result: serveStatusResult },
          onPress: vi.fn(),
          onLongPress: vi.fn(),
          onOpenActions: vi.fn()
        })
      )
    })
    consoleError.mockRestore()

    const root = renderer!.root
    expect(root.findByProps({ testID: 'host-card-availability' }).children).toEqual([
      'Awake · Host Service running'
    ])
    const capabilityLine = root.findByProps({ testID: 'host-card-capabilities' }).children
    expect(capabilityLine).toHaveLength(1)
    expect(String(capabilityLine[0])).toContain('Relay: yes')
    expect(root.findAllByType('Pressable')).toHaveLength(2)
  })
})

type CardCaseProps = {
  state: ConnectionState
  verdict: ConnectionVerdict
  credentialStatus?: HostCredentialStatus
  lastConnectedAt?: number | null
  statusSnapshot?: HomeHostStatusSnapshot
}

const POWER_LOSS_WORDS = /powered[\s-]?off|asleep|sleeping|hibernat|offline/i
const EFFECT_WORDS = /\b(wake|power[\s-]?on)\b/i
const oldHostResult = {
  protocolVersion: MIN_COMPATIBLE_DESKTOP_VERSION,
  graphStatus: 'ready',
  desktopWindowStatus: 'openable'
}
const connectedNormal = {
  state: 'connected',
  verdict: { kind: 'normal', label: 'Connected' }
} as const

const CARD_CASES: Array<[string, CardCaseProps]> = [
  [
    'disconnected without an answer',
    { state: 'disconnected', verdict: { kind: 'normal', label: 'Disconnected' } }
  ],
  [
    'old host, current answer',
    {
      ...connectedNormal,
      lastConnectedAt: 1000,
      statusSnapshot: { observedAt: 2000, result: oldHostResult }
    }
  ],
  [
    'stale answer',
    {
      ...connectedNormal,
      lastConnectedAt: 3000,
      statusSnapshot: { observedAt: 2000, result: serveStatusResult }
    }
  ],
  [
    'version mismatch',
    {
      ...connectedNormal,
      lastConnectedAt: 1000,
      statusSnapshot: { observedAt: 2000, result: { ...oldHostResult, protocolVersion: 0 } }
    }
  ],
  [
    'credential missing with a current answer',
    {
      state: 'connected',
      verdict: { kind: 'auth-failed', label: 'Pairing invalid' },
      credentialStatus: 'missing',
      lastConnectedAt: 1000,
      statusSnapshot: { observedAt: 2000, result: serveStatusResult }
    }
  ],
  [
    'serve host with announced capabilities',
    {
      ...connectedNormal,
      lastConnectedAt: 1000,
      statusSnapshot: { observedAt: 2000, result: serveStatusResult }
    }
  ]
]

describe('MobileHostCard availability projection', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  async function renderCase(props: CardCaseProps) {
    const consoleError = suppressRendererDeprecation()
    await act(async () => {
      renderer = create(
        createElement(MobileHostCard, {
          host: {
            id: 'desk',
            name: 'Desk',
            endpoint: 'ws://192.168.1.2:6768',
            deviceToken: 'token',
            publicKeyB64: 'key',
            lastConnected: 1
          },
          path: 'lan',
          ...props,
          onPress: vi.fn(),
          onLongPress: vi.fn(),
          onOpenActions: vi.fn()
        })
      )
    })
    consoleError.mockRestore()
    const root = renderer!.root
    const availability = root.findByProps({ testID: 'host-card-availability' })
    const capabilities = root.findByProps({ testID: 'host-card-capabilities' })
    return { root, availability, capabilities, availabilityText: availability.children.join('') }
  }

  it('states unknown for a disconnected host and offers exactly the two classified controls', async () => {
    const { root, availabilityText } = await renderCase(CARD_CASES[0][1])

    expect(availabilityText).toBe('Power unknown · Orca unknown')
    const buttons = root.findAllByType('Pressable')
    expect(buttons.map((button) => button.props.testID)).toEqual([
      'host-card-open',
      'host-card-actions'
    ])
  })

  it('reads an old host as running with unknown capabilities', async () => {
    const { availabilityText, capabilities } = await renderCase(CARD_CASES[1][1])

    expect(availabilityText).toBe('Awake · Orca running, window closed')
    expect(capabilities.children).toEqual(['Capabilities unknown'])
  })

  it('does not call the host awake on an answer from before the latest connect', async () => {
    const { availabilityText } = await renderCase(CARD_CASES[2][1])

    expect(availabilityText).toBe('Power unknown · Orca unknown')
  })

  it('colours a version mismatch with the amber status token', async () => {
    const { availability, availabilityText } = await renderCase(CARD_CASES[3][1])

    expect(availabilityText).toBe('Awake · Orca version mismatch')
    expect(availability.props.style[1]).toEqual({ color: colors.statusAmber })
  })

  it('reads unknown while the pairing credential is missing', async () => {
    const { availabilityText } = await renderCase(CARD_CASES[4][1])

    expect(availabilityText).toBe('Power unknown · Orca unknown')
  })

  it.each(CARD_CASES)(
    'renders no power-loss word and no effect control (%s)',
    async (_name, props) => {
      const { root, capabilities } = await renderCase(props)
      const capabilityText = capabilities.children.join('')
      const otherTexts = root
        .findAllByType('Text')
        .filter((node) => node.props.testID !== 'host-card-capabilities')
        .map((node) => node.children.filter((child) => typeof child === 'string').join(''))
      const buttons = root.findAllByType('Pressable')

      expect(buttons).toHaveLength(2)
      for (const text of [...otherTexts, capabilityText]) {
        expect(text).not.toMatch(POWER_LOSS_WORDS)
      }
      for (const text of otherTexts) {
        expect(text).not.toMatch(EFFECT_WORDS)
      }
      const spokenCapabilities = capabilityText.split(' · ').join(', ')
      for (const button of buttons) {
        const label = String(button.props.accessibilityLabel).replace(spokenCapabilities, '')
        expect(label).not.toMatch(EFFECT_WORDS)
        expect(label).not.toMatch(POWER_LOSS_WORDS)
      }
    }
  )
})
