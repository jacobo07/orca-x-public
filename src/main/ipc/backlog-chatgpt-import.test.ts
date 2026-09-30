// The dialog is crossed at dialog.showOpenDialog (the Electron boundary); the runner, the service and
// the file are real. Export shape ASSUMED (research Q3): UNVERIFIED-ON-REAL-EXPORT (D-13).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BacklogChatGptImportAnswer } from '../../shared/backlog-harvest-report'
import { BacklogService } from '../backlog/backlog-service'
import {
  createBacklogHarvestRunner,
  type BacklogHarvestRunner
} from '../backlog/harvest/backlog-harvest-runner'

const { dialogMock, fromWebContentsMock, getFocusedWindowMock, handleMock, wiring } = vi.hoisted(
  () => ({
    dialogMock: { showOpenDialog: vi.fn() } as { showOpenDialog: (...args: unknown[]) => unknown },
    fromWebContentsMock: vi.fn(),
    getFocusedWindowMock: vi.fn(),
    handleMock: vi.fn(),
    wiring: { runner: null as unknown }
  })
)

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: fromWebContentsMock, getFocusedWindow: getFocusedWindowMock },
  dialog: dialogMock,
  ipcMain: { handle: handleMock }
}))

vi.mock('./backlog-host-wiring', () => ({
  getBacklogHarvestRunner: () => wiring.runner
}))

import {
  handleBacklogChatGptImport,
  registerBacklogChatGptImportHandler
} from './backlog-chatgpt-import'

const CHANNEL = 'backlog:importChatGptExport'

const exportMembers = [
  {
    id: 'conv-a',
    update_time: 1_700_000_500,
    current_node: 'u1',
    mapping: {
      u1: {
        id: 'u1',
        parent: null,
        children: [],
        message: {
          id: 'm1',
          author: { role: 'user', name: null, metadata: {} },
          create_time: 1_700_000_100,
          content: { content_type: 'text', parts: ['- [ ] rotate the keys'] },
          metadata: {}
        }
      }
    }
  }
]

/** Every string anywhere in a value, however deep. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsIn)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...stringsIn(entry)])
  }
  return []
}

function leaks(answer: unknown, needles: string[]): boolean {
  return stringsIn(answer).some((text) => needles.some((needle) => text.includes(needle)))
}

describe('backlog ChatGPT export import IPC', () => {
  let dir: string
  let exportPath: string
  let ledger: string
  let ingest: ReturnType<typeof vi.fn>
  let runner: BacklogHarvestRunner
  const event = { sender: {} } as Electron.IpcMainInvokeEvent

  const pick = (filePaths: string[]) => {
    dialogMock.showOpenDialog = vi.fn(async () => ({
      canceled: filePaths.length === 0,
      filePaths
    }))
  }
  const unitStatus = async () =>
    (await runner.status()).units.find((unit) => unit.unit === 'chatgpt-export')?.status

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-chatgpt-ipc-'))
    ledger = join(dir, 'backlog')
    exportPath = join(dir, 'my-chatgpt-export-2026.json')
    writeFileSync(exportPath, JSON.stringify(exportMembers))
    const service = new BacklogService(() => ledger)
    ingest = vi.fn((entries) => service.ingestCandidates(entries))
    runner = createBacklogHarvestRunner({
      service: { ingestCandidates: ingest },
      sources: {
        conversations: () => {
          throw new Error('not used')
        },
        transcripts: () => {
          throw new Error('not used')
        }
      },
      ledgerRoot: () => ledger
    })
    wiring.runner = runner
    fromWebContentsMock.mockReset().mockReturnValue(null)
    getFocusedWindowMock.mockReset().mockReturnValue(null)
    handleMock.mockReset()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('answers cancelled and ingests nothing when the dialog is cancelled', async () => {
    pick([])

    expect(await handleBacklogChatGptImport(event, runner)).toEqual({ outcome: 'cancelled' })
    expect(ingest).not.toHaveBeenCalled()
    expect(await unitStatus()).toBe('not-run')
  })

  it('asks for one JSON file, imports it, and never answers with the path or file name', async () => {
    pick([exportPath])

    const answer = await handleBacklogChatGptImport(event, runner)

    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: ['openFile'],
        filters: [{ name: 'ChatGPT export', extensions: ['json'] }]
      })
    )
    expect(answer).toMatchObject({
      outcome: 'imported',
      report: { outcome: 'completed', unit: 'chatgpt-export', candidatesNew: 1 }
    })
    const needles = [exportPath, basename(exportPath), dir]
    expect(leaks(answer, needles)).toBe(false)
    // Planted control: the same walker finds the base name two levels deep inside the report.
    const planted = structuredClone(answer) as { report: Record<string, unknown> }
    planted.report.skipped = { nested: { name: basename(exportPath) } }
    expect(leaks(planted, needles)).toBe(true)
    expect(await unitStatus()).toBe('connected')
  })

  it('parents the dialog on the sender window when there is one', async () => {
    const win = { id: 7 }
    fromWebContentsMock.mockReturnValue(win)
    pick([])

    await handleBacklogChatGptImport(event, runner)

    expect(dialogMock.showOpenDialog).toHaveBeenCalledWith(
      win,
      expect.objectContaining({ properties: ['openFile'] })
    )
  })

  it('answers refused with the code and marks the unit refused', async () => {
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{')
    pick([broken])

    const answer = await handleBacklogChatGptImport(event, runner)

    expect(answer).toMatchObject({ outcome: 'refused', report: { code: 'not-json' } })
    expect(leaks(answer, [broken, 'broken.json'])).toBe(false)
    expect(ingest).not.toHaveBeenCalled()
    expect(await unitStatus()).toBe('refused')
  })

  it('refuses a second import started while the first runs, through the shared runner', async () => {
    pick([exportPath])

    const answers = await Promise.all([
      handleBacklogChatGptImport(event, runner),
      handleBacklogChatGptImport(event, runner)
    ])

    expect(answers.map((answer) => answer.outcome).toSorted()).toEqual(['imported', 'refused'])
    expect(answers.find((answer) => answer.outcome === 'refused')).toMatchObject({
      report: { code: 'already-running' }
    })
  })

  it('registers the channel on the wiring runner and reads the dialog at call time', async () => {
    registerBacklogChatGptImportHandler()
    expect(handleMock).toHaveBeenCalledWith(CHANNEL, expect.any(Function))
    const handler = handleMock.mock.calls[0][1] as (
      event: Electron.IpcMainInvokeEvent,
      ...args: unknown[]
    ) => Promise<BacklogChatGptImportAnswer>

    // Replaced AFTER registration, as the e2e seam does.
    pick([exportPath])
    const answer = await handler(event, 'C:\\renderer\\chosen.json')

    expect(answer).toMatchObject({ outcome: 'imported', report: { candidatesNew: 1 } })
    expect(dialogMock.showOpenDialog).toHaveBeenCalledTimes(1)
    expect(await unitStatus()).toBe('connected')
  })
})
