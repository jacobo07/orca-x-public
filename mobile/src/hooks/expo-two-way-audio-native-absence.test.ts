import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: an APK built without this native module (0.0.43, logcat 2026-10-27) died on every session-route
// open: the route imports dictation, and expo's requireNativeModule throws at import time.
const native = vi.hoisted(() => ({
  module: null as Record<string, (...args: unknown[]) => unknown> | null
}))

vi.mock('expo-modules-core', () => ({
  requireNativeModule: (name: string) => {
    if (!native.module) {
      throw new Error(`Cannot find native module '${name}'`)
    }
    return native.module
  },
  requireOptionalNativeModule: () => native.module,
  createPermissionHook: () => () => [null, async () => null, async () => null]
}))
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  Platform: { OS: 'android' }
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: async () => undefined,
  deactivateKeepAwake: async () => undefined
}))

const PACKAGE = '../../packages/expo-two-way-audio/src'

function presentModule() {
  return {
    initialize: vi.fn(async () => true),
    toggleRecording: vi.fn(() => true),
    tearDown: vi.fn(),
    addListener: vi.fn(() => ({ remove: vi.fn() }))
  }
}

describe('@orca/expo-two-way-audio when the binary lacks its native module', () => {
  beforeEach(() => {
    vi.resetModules()
    native.module = null
  })

  it('imports without throwing and reports the module unavailable', async () => {
    const audio = await import(PACKAGE)
    expect(audio.isExpoTwoWayAudioAvailable()).toBe(false)
  })

  it('refuses each native call with the typed unavailable error', async () => {
    const audio = await import(PACKAGE)
    await expect(audio.initialize()).rejects.toBeInstanceOf(audio.ExpoTwoWayAudioUnavailableError)
    expect(() => audio.toggleRecording(true)).toThrow(audio.ExpoTwoWayAudioUnavailableError)
    expect(() =>
      audio.addExpoTwoWayAudioEventListener('onMicrophoneData', () => undefined)
    ).toThrow(audio.ExpoTwoWayAudioUnavailableError)
  })

  it('delegates to the native module when the binary has it (positive control)', async () => {
    const present = presentModule()
    native.module = present
    const audio = await import(PACKAGE)
    expect(audio.isExpoTwoWayAudioAvailable()).toBe(true)
    await expect(audio.initialize()).resolves.toBe(true)
    expect(present.initialize).toHaveBeenCalledTimes(1)
  })
})

describe('useMobileDictation when the binary lacks the audio module', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    vi.resetModules()
    native.module = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function mount() {
    const { useMobileDictation } = await import('./use-mobile-dictation')
    const result: { current: ReturnType<typeof useMobileDictation> | null } = { current: null }
    function Harness(): null {
      result.current = useMobileDictation({
        client: { sendRequest: vi.fn() } as never,
        enabled: true,
        onTranscript: () => undefined
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    return result
  }

  it('mounts and unmounts, reports unavailable, and refuses start with a readable reason', async () => {
    const dictation = await mount()
    expect(dictation.current?.available).toBe(false)
    let refusal: unknown = null
    await act(async () => {
      await dictation.current!.start().catch((err: unknown) => {
        refusal = err
      })
    })
    expect(String(refusal)).toMatch(/not available in this app build/)
    // A refusal that first set 'starting' would leave the mic button stuck.
    expect(dictation.current?.status).toBe('idle')
    act(() => renderer?.unmount())
    renderer = null
  })

  it('subscribes to native audio events when the module is present (positive control)', async () => {
    const present = presentModule()
    native.module = present
    const dictation = await mount()
    expect(dictation.current?.available).toBe(true)
    expect(present.addListener).toHaveBeenCalledWith('onMicrophoneData', expect.any(Function))
  })
})
