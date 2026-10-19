import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostProfile } from '../transport/types'
import { MobileSessionHostPicker } from './MobileSessionHostPicker'

const useAllHostClientsMock = vi.hoisted(() => vi.fn())

vi.mock('../transport/use-all-host-clients', () => ({
  useAllHostClients: useAllHostClientsMock
}))

vi.mock('../components/PickerModal', async () => {
  const React = await import('react')
  return {
    PickerModal: (props: unknown) => React.createElement('PickerModal', props)
  }
})

function host(id: string, name: string, lastConnected: number): HostProfile {
  return {
    id,
    name,
    endpoint: `ws://${id}.local:6768`,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected
  }
}

const desk = host('desk', 'Desk', 2)
const laptop = host('laptop', 'Laptop', 1)

describe('MobileSessionHostPicker', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    useAllHostClientsMock.mockReset()
    useAllHostClientsMock.mockImplementation((ids: string[]) =>
      ids.includes('laptop') ? [{ hostId: 'laptop', state: 'connected' }] : []
    )
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function renderPicker(visible: boolean) {
    const onClose = vi.fn()
    const onSwitchHost = vi.fn()
    const element = (open: boolean) =>
      createElement(MobileSessionHostPicker, {
        visible: open,
        hosts: [desk, laptop],
        currentHostId: 'desk',
        onClose,
        onSwitchHost
      })
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
    await act(async () => {
      renderer = create(element(visible))
    })
    consoleError.mockRestore()
    return {
      onClose,
      onSwitchHost,
      rerender: async (open: boolean) => {
        await act(async () => renderer!.update(element(open)))
      }
    }
  }

  function picker() {
    return renderer!.root.findByType('PickerModal')
  }

  it('observes host states without ever connecting one', async () => {
    const view = await renderPicker(false)
    await view.rerender(true)
    for (const [, options] of useAllHostClientsMock.mock.calls) {
      expect(options).toEqual({ autoConnectHostIds: [] })
    }
  })

  it('tracks no host while closed and every paired host while open', async () => {
    const view = await renderPicker(false)
    expect(useAllHostClientsMock).toHaveBeenLastCalledWith([], { autoConnectHostIds: [] })
    await view.rerender(true)
    expect(useAllHostClientsMock).toHaveBeenLastCalledWith(['desk', 'laptop'], {
      autoConnectHostIds: []
    })
  })

  it('shows each host with its observed state and selects the current one', async () => {
    await renderPicker(true)
    expect(picker().props.title).toBe('Switch host')
    expect(picker().props.selected).toBe('desk')
    expect(picker().props.options).toEqual([
      { value: 'desk', label: 'Desk', subtitle: 'Not connected · desk.local:6768' },
      { value: 'laptop', label: 'Laptop', subtitle: 'Connected · laptop.local:6768' }
    ])
  })

  it('switches only after the picker has closed', async () => {
    const view = await renderPicker(true)
    act(() => picker().props.onSelect('laptop'))
    expect(view.onSwitchHost).not.toHaveBeenCalled()
    act(() => picker().props.onAfterClose())
    expect(view.onSwitchHost).toHaveBeenCalledWith('laptop')
  })

  it('does nothing when the current host is chosen', async () => {
    const view = await renderPicker(true)
    act(() => picker().props.onSelect('desk'))
    act(() => picker().props.onAfterClose())
    expect(view.onSwitchHost).not.toHaveBeenCalled()
  })

  it('does not switch when the picker is dismissed without a choice', async () => {
    const view = await renderPicker(true)
    act(() => picker().props.onClose())
    act(() => picker().props.onAfterClose())
    expect(view.onClose).toHaveBeenCalledOnce()
    expect(view.onSwitchHost).not.toHaveBeenCalled()
  })
})
