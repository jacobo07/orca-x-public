// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PrepareStepApprovalDialog,
  type PrepareStepApprovalDialogProps
} from './PrepareStepApprovalDialog'

const BYTES = '  sudo apt-get install -y nodejs  \nnpm ci  '

let root: Root
let onApprove: ReturnType<typeof vi.fn>
let onApproved: ReturnType<typeof vi.fn>
let onCancel: ReturnType<typeof vi.fn>

async function renderDialog(
  overrides: Partial<PrepareStepApprovalDialogProps> = {}
): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <PrepareStepApprovalDialog
        open
        repoName="orca"
        hostLabel="laptop@abc123"
        step={{
          requirementId: 'node',
          bytes: BYTES,
          labels: ['asks-for-elevation', 'script-content-not-covered']
        }}
        onApprove={onApprove as unknown as () => Promise<void>}
        onApproved={onApproved as unknown as () => void}
        onCancel={onCancel as unknown as () => void}
        {...overrides}
      />
    )
  )
}

function handle<T extends HTMLElement = HTMLElement>(name: string): T | null {
  return document.querySelector<T>(`[${name}]`)
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  onApprove = vi.fn().mockResolvedValue(undefined)
  onApproved = vi.fn()
  onCancel = vi.fn()
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
})

describe('PrepareStepApprovalDialog', () => {
  it('shows the exact bytes', async () => {
    await renderDialog()
    const pre = handle('data-prepare-approval-bytes')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toBe(BYTES)
  })

  it('names the labels in words and the host', async () => {
    await renderDialog()
    const labels = [...document.querySelectorAll('[data-prepare-step-label]')].map((el) =>
      el.getAttribute('data-prepare-step-label')
    )
    expect(labels).toEqual(['asks-for-elevation', 'script-content-not-covered'])
    expect(handle('data-prepare-approval-dialog')?.textContent).toContain('laptop@abc123')
  })

  it('confirm waits for the approval write', async () => {
    let release!: () => void
    onApprove.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)))
    await renderDialog()
    const confirm = handle<HTMLButtonElement>('data-prepare-approve')!
    await act(async () => confirm.click())
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onApproved).not.toHaveBeenCalled()
    expect(handle('data-prepare-approval-pending')).not.toBeNull()
    expect(handle<HTMLButtonElement>('data-prepare-approve')?.disabled).toBe(true)
    await act(async () => {
      release()
      await Promise.resolve()
    })
    await flush()
    expect(onApproved).toHaveBeenCalledTimes(1)
  })

  it('rejected approval write runs nothing', async () => {
    onApprove.mockRejectedValueOnce(new Error('raw disk message'))
    await renderDialog()
    await act(async () => handle<HTMLButtonElement>('data-prepare-approve')!.click())
    await flush()
    expect(onApproved).not.toHaveBeenCalled()
    const error = handle('data-prepare-approval-error')
    expect(error).not.toBeNull()
    expect(error?.textContent).not.toContain('raw disk message')
    expect(handle<HTMLButtonElement>('data-prepare-approve')?.disabled).toBe(false)
    expect(handle('data-prepare-approval-dialog')).not.toBeNull()
  })

  it('cancel only cancels', async () => {
    await renderDialog()
    await act(async () => handle<HTMLButtonElement>('data-prepare-cancel')!.click())
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onApprove).not.toHaveBeenCalled()
    expect(onApproved).not.toHaveBeenCalled()
  })

  it('offers no always-trust shortcut', async () => {
    await renderDialog()
    const dialog = handle('data-prepare-approval-dialog')
    expect(dialog).not.toBeNull()
    expect(dialog?.querySelectorAll('input[type=checkbox]').length).toBe(0)
    expect(dialog?.querySelectorAll('[role=checkbox],[role=switch]').length).toBe(0)
  })
})
