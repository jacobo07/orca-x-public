import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const router = vi.hoisted(() => ({
  canGoBack: vi.fn(() => true),
  back: vi.fn(),
  replace: vi.fn()
}))

vi.mock('react-native', () => ({
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) =>
    createElement('Pressable', { onPress }, children),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('expo-router', () => ({ useRouter: () => router }))

import { RouteErrorFallback, createRouteErrorId } from './RouteErrorFallback'

describe('RouteErrorFallback', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })

  function render(retry = vi.fn(async () => undefined)) {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    act(() => {
      renderer = create(
        createElement(RouteErrorFallback, {
          error: new Error("Cannot find native module 'ExpoTwoWayAudio'"),
          retry
        })
      )
    })
    return retry
  }

  function texts(): string[] {
    return renderer!.root
      .findAll((node) => node.type === 'Text')
      .map((node) => node.children.join(''))
  }

  it('shows the fault and a correlation id it also logs', () => {
    render()
    const shown = texts()
    expect(shown).toContain("Cannot find native module 'ExpoTwoWayAudio'")
    const id = shown.find((text) => text.startsWith('route-'))
    expect(id).toBeDefined()
    expect(console.error).toHaveBeenCalledWith(`[route-error] ${id}`, expect.any(Error))
  })

  it('retries the route and goes back without leaving the app', () => {
    const retry = render()
    const [tryAgain, back] = renderer!.root.findAll((node) => node.type === 'Pressable')
    act(() => tryAgain.props.onPress())
    expect(retry).toHaveBeenCalledTimes(1)
    act(() => back.props.onPress())
    expect(router.back).toHaveBeenCalledTimes(1)
    router.canGoBack.mockReturnValueOnce(false)
    act(() => back.props.onPress())
    expect(router.replace).toHaveBeenCalledWith('/')
  })

  it('mints distinct correlation ids', () => {
    expect(createRouteErrorId(1, 0.1)).not.toBe(createRouteErrorId(1, 0.2))
  })
})
