import { beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBox, getAllWindows, fromWebContents } = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  getAllWindows: vi.fn(() => [] as unknown[]),
  fromWebContents: vi.fn(() => null as unknown)
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows, fromWebContents },
  dialog: { showMessageBox }
}))
vi.mock('../i18n/main-i18n', () => ({
  translateMain: (_key: string, fallback: string) => fallback
}))

import {
  confirmRendererReplacement,
  describeReplacementAbandoned,
  replaceUnansweringRenderer,
  sharesRendererProcess,
  type ForceReloadReplacementDeps
} from './force-reload-replacement'

function target(id: number, pid = 4000 + id) {
  return { id, isDestroyed: () => false, getOSProcessId: () => pid }
}

function deps(overrides: Partial<ForceReloadReplacementDeps> = {}): ForceReloadReplacementDeps {
  return {
    confirm: vi.fn(async () => true),
    sharesRendererProcess: vi.fn(() => false),
    notifySharedRenderer: vi.fn(),
    replace: vi.fn(async () => 'replaced' as const),
    ...overrides
  }
}

describe('replaceUnansweringRenderer', () => {
  it('replaces the renderer once the user confirms', async () => {
    const d = deps()
    await expect(replaceUnansweringRenderer(target(1) as never, d)).resolves.toBe('replaced')
    expect(d.confirm).toHaveBeenCalledTimes(1)
    expect(d.replace).toHaveBeenCalledWith(1)
  })

  it('changes nothing when the user cancels', async () => {
    const d = deps({ confirm: vi.fn(async () => false) })
    await expect(replaceUnansweringRenderer(target(2) as never, d)).resolves.toBe('cancelled')
    expect(d.replace).not.toHaveBeenCalled()
  })

  it('refuses without asking when another window shares the renderer process', async () => {
    const d = deps({ sharesRendererProcess: vi.fn(() => true) })
    await expect(replaceUnansweringRenderer(target(3) as never, d)).resolves.toBe('shared-renderer')
    expect(d.confirm).not.toHaveBeenCalled()
    expect(d.replace).not.toHaveBeenCalled()
    expect(d.notifySharedRenderer).toHaveBeenCalledTimes(1)
  })

  it('re-checks the shared process after the confirm, which can stay open for minutes', async () => {
    const shares = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const d = deps({ sharesRendererProcess: shares })
    await expect(replaceUnansweringRenderer(target(4) as never, d)).resolves.toBe('shared-renderer')
    expect(d.replace).not.toHaveBeenCalled()
  })

  it('does nothing to a window that closed while the confirm was open', async () => {
    let destroyed = false
    const t = { id: 5, isDestroyed: () => destroyed, getOSProcessId: () => 5 }
    const d = deps({
      confirm: vi.fn(async () => {
        destroyed = true
        return true
      })
    })
    await expect(replaceUnansweringRenderer(t as never, d)).resolves.toBe('gone')
    expect(d.replace).not.toHaveBeenCalled()
  })
})

describe('sharesRendererProcess', () => {
  beforeEach(() => getAllWindows.mockReset())

  it('is true only when another live window reports the same renderer pid', () => {
    const self = target(10, 777)
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: self },
      { isDestroyed: () => false, webContents: target(11, 888) }
    ])
    expect(sharesRendererProcess(self as never)).toBe(false)

    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: self },
      { isDestroyed: () => false, webContents: target(12, 777) }
    ])
    expect(sharesRendererProcess(self as never)).toBe(true)
  })

  it('ignores a pid of 0, which is a renderer that has no process, not a shared one', () => {
    const self = target(13, 0)
    getAllWindows.mockReturnValue([{ isDestroyed: () => false, webContents: target(14, 0) }])
    expect(sharesRendererProcess(self as never)).toBe(false)
  })
})

describe('confirmRendererReplacement', () => {
  beforeEach(() => showMessageBox.mockReset())

  it('makes Cancel the default and the escape answer', async () => {
    showMessageBox.mockResolvedValue({ response: 0 })
    await expect(confirmRendererReplacement(target(20) as never)).resolves.toBe(false)
    const options = showMessageBox.mock.calls[0].at(-1)
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
    expect(options.buttons).toHaveLength(2)
    expect(`${options.message} ${options.detail}`).toMatch(/unsaved/i)
  })

  it('confirms only on the replace button', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })
    await expect(confirmRendererReplacement(target(21) as never)).resolves.toBe(true)
  })

  it('treats a dialog that failed to open as Cancel', async () => {
    showMessageBox.mockRejectedValueOnce(new Error('window closed'))
    const answer = await confirmRendererReplacement(target(22) as never)
    expect(showMessageBox.mock.calls.length).toBe(1)
    expect(answer).toBe(false)
  })
})
describe('describeReplacementAbandoned', () => {
  it('says the window was left as it was and where to go next, never that it restarted', () => {
    const { message, detail } = describeReplacementAbandoned()
    expect(message).toMatch(/could not be restarted/i)
    expect(detail).toMatch(/left the window as it was/i)
    expect(detail).toMatch(/open a new one/i)
  })
})
