// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { EnvironmentRequirementsMeasurement } from '../../../../shared/environment-requirements-measurement'
import type { Repo } from '../../../../shared/repo-types'
import type { PrepareHostBlockSpec } from './prepare-host-blocks'

const hoisted = vi.hoisted(() => ({
  storeState: {
    trustedOrcaHooks: {} as Record<string, unknown>,
    approvePrepareStep: undefined as unknown as (...args: unknown[]) => Promise<void>
  },
  blocks: [] as unknown[],
  measure: undefined as unknown as Mock<(...args: unknown[]) => unknown>,
  runStep: undefined as unknown as Mock<(...args: unknown[]) => unknown>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof hoisted.storeState) => unknown) =>
    selector(hoisted.storeState)
}))
vi.mock('./use-prepare-host-blocks', () => ({ usePrepareHostBlocks: () => hoisted.blocks }))
vi.mock('../../runtime/runtime-environment-requirements-client', () => ({
  measureRequirementsForRuntimeTarget: (...args: unknown[]) => hoisted.measure(...args),
  runPrepareStepForRuntimeTarget: (...args: unknown[]) => hoisted.runStep(...args)
}))

import { PrepareThisDeviceSection } from './PrepareThisDeviceSection'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const PREPARE_BYTES = 'sudo ./scripts/setup.sh'

function measurementFor(
  hostKey: string,
  contentHash: string,
  contract: EnvironmentRequirementsMeasurement['contract'] = 'parsed'
): EnvironmentRequirementsMeasurement {
  return {
    contractSource:
      contract === 'parsed' ? { hostKey, path: '/work/orca.yaml', contentHash } : null,
    contract,
    diagnostics: [],
    requirements: [
      { id: 'git', kind: 'command', name: 'git', versionArg: '--version' },
      { id: 'curl', kind: 'command', name: 'curl', versionArg: '--version' },
      {
        id: 'node',
        kind: 'command',
        name: 'node',
        versionArg: '--version',
        versionRange: {
          status: 'supported',
          raw: '>=20',
          comparators: [{ op: '>=', version: [20, 0, 0] }]
        }
      },
      {
        id: 'cuda',
        kind: 'command',
        name: 'nvcc',
        versionArg: '--version',
        platforms: [{ os: 'darwin' }]
      },
      {
        id: 'setup-tool',
        kind: 'command',
        name: 'setup-tool',
        versionArg: '--version',
        prepare: PREPARE_BYTES
      },
      { id: 'ghost', kind: 'quantum', unsupportedByThisOrca: true }
    ],
    measurement: {
      status: 'measured',
      at: 1_700_000_000_000,
      hostKey,
      platform: { os: 'linux', arch: 'x64' },
      probes: [
        { id: 'git', outcome: 'found', version: '2.52.0' },
        { id: 'curl', outcome: 'absent' },
        { id: 'node', outcome: 'found', version: '18.0.0' },
        { id: 'cuda', outcome: 'skipped-platform' },
        { id: 'setup-tool', outcome: 'absent' }
      ]
    }
  }
}

const LAPTOP: PrepareHostBlockSpec = {
  key: 'laptop',
  repoId: 'r1',
  hostLabel: 'This device',
  target: { kind: 'local' }
}
const BOX: PrepareHostBlockSpec = {
  key: 'box',
  repoId: 'r2',
  hostLabel: 'Build box',
  target: { kind: 'environment', environmentId: 'env-1' }
}

const GIT_REPO = { id: 'r1', displayName: 'orca', kind: 'git' } as unknown as Repo
const FOLDER_REPO = { id: 'r1', displayName: 'notes', kind: 'folder' } as unknown as Repo

let root: Root

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function renderSection(repo: Repo = GIT_REPO): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<PrepareThisDeviceSection repo={repo} />))
}

function q<T extends HTMLElement = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector)
}

async function clickMeasure(key: string): Promise<void> {
  await act(async () => q(`[data-prepare-measure="${key}"]`)!.click())
  await settle()
}

beforeEach(() => {
  hoisted.blocks = [LAPTOP]
  hoisted.storeState.trustedOrcaHooks = {}
  hoisted.storeState.approvePrepareStep = vi.fn().mockResolvedValue(undefined)
  hoisted.measure = vi.fn().mockResolvedValue({
    status: 'measured',
    result: measurementFor('laptop@abc', HASH_A)
  })
  hoisted.runStep = vi.fn().mockResolvedValue({ status: 'started' })
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
})

describe('PrepareThisDeviceSection', () => {
  it('measures only when asked', async () => {
    await renderSection()
    await settle()
    expect(q('[data-prepare-device-section]')).not.toBeNull()
    expect(hoisted.measure).not.toHaveBeenCalled()
    expect(q('[data-requirement-id]')).toBeNull()
  })

  it('shows six states with handles, the contract source and a folder repo the same way', async () => {
    await renderSection(FOLDER_REPO)
    await clickMeasure('laptop')
    expect(q('[data-prepare-device-section]')).not.toBeNull()
    const states = Object.fromEntries(
      [...document.querySelectorAll('[data-requirement-id]')].map((el) => [
        el.getAttribute('data-requirement-id'),
        el.getAttribute('data-requirement-state')
      ])
    )
    expect(states).toEqual({
      git: 'satisfied',
      curl: 'missing',
      node: 'incompatible',
      cuda: 'unsupported',
      'setup-tool': 'needs-authorization',
      ghost: 'unknown'
    })
    const source = q('[data-prepare-contract-source]')?.textContent ?? ''
    expect(source).toContain('laptop@abc')
    expect(source).toContain(HASH_A.slice(0, 8))
  })

  it('states the reason for an unknown row and never gives it a success tone', async () => {
    await renderSection()
    await clickMeasure('laptop')
    const ghost = q('[data-requirement-id="ghost"]')!
    expect(ghost.getAttribute('data-requirement-reason')).toBe('kind-not-evaluated')
    expect(ghost.innerHTML).not.toContain('status-success')
    expect(q('[data-requirement-id="git"]')!.innerHTML).toContain('status-success')
  })

  it('does not re-measure on its own', async () => {
    await renderSection()
    await clickMeasure('laptop')
    await act(async () => q('[data-prepare-run="setup-tool"]')!.click())
    await act(async () => q('[data-prepare-approve]')!.click())
    await settle()
    expect(hoisted.runStep).toHaveBeenCalledTimes(1)
    expect(q('[data-prepare-step-started="setup-tool"]')).not.toBeNull()
    await settle()
    expect(hoisted.measure).toHaveBeenCalledTimes(1)
  })

  it('records the approval before the run request is sent', async () => {
    let release!: () => void
    hoisted.storeState.approvePrepareStep = vi
      .fn()
      .mockReturnValue(new Promise<void>((resolve) => (release = resolve)))
    await renderSection()
    await clickMeasure('laptop')
    await act(async () => q('[data-prepare-run="setup-tool"]')!.click())
    expect(q('[data-prepare-approval-bytes]')?.textContent).toBe(PREPARE_BYTES)
    await act(async () => q('[data-prepare-approve]')!.click())
    await settle()
    expect(hoisted.storeState.approvePrepareStep).toHaveBeenCalledWith(
      'r1',
      'setup-tool',
      expect.stringMatching(/^[0-9a-f]{64}$/)
    )
    expect(hoisted.runStep).not.toHaveBeenCalled()
    await act(async () => release())
    await settle()
    expect(hoisted.runStep).toHaveBeenCalledWith(
      { kind: 'local' },
      'r1',
      expect.objectContaining({
        requirementId: 'setup-tool',
        approvedHostKey: 'laptop@abc',
        approvedContentHash: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
    )
    expect(Object.keys(hoisted.runStep.mock.calls[0][2] as object)).not.toContain('command')
  })

  it('runs nothing when the approval could not be recorded', async () => {
    hoisted.storeState.approvePrepareStep = vi.fn().mockRejectedValue(new Error('disk'))
    await renderSection()
    await clickMeasure('laptop')
    await act(async () => q('[data-prepare-run="setup-tool"]')!.click())
    await act(async () => q('[data-prepare-approve]')!.click())
    await settle()
    expect(hoisted.runStep).not.toHaveBeenCalled()
    expect(q('[data-prepare-approval-error]')).not.toBeNull()
  })

  it('renders a refusal in words with its handle', async () => {
    hoisted.runStep = vi.fn().mockResolvedValue({ status: 'refused', reason: 'contract-changed' })
    await renderSection()
    await clickMeasure('laptop')
    await act(async () => q('[data-prepare-run="setup-tool"]')!.click())
    await act(async () => q('[data-prepare-approve]')!.click())
    await settle()
    const refusal = q('[data-prepare-refusal]')
    expect(refusal?.getAttribute('data-prepare-refusal')).toBe('contract-changed')
    expect(refusal?.textContent).not.toContain('contract-changed')
    expect(q('[data-prepare-step-started]')).toBeNull()
  })

  it('offers a run button only for a declared step that can be acted on', async () => {
    await renderSection()
    await clickMeasure('laptop')
    expect(q('[data-prepare-run="setup-tool"]')).not.toBeNull()
    expect(q('[data-prepare-run="git"]')).toBeNull()
    expect(q('[data-prepare-run="curl"]')).toBeNull()
  })

  it('flags a host whose contract differs from another host and never merges them', async () => {
    hoisted.blocks = [LAPTOP, BOX]
    hoisted.measure = vi.fn().mockImplementation((_target: unknown, repoId: string) =>
      Promise.resolve({
        status: 'measured',
        result:
          repoId === 'r1' ? measurementFor('laptop@abc', HASH_A) : measurementFor('box@def', HASH_B)
      })
    )
    await renderSection()
    await clickMeasure('laptop')
    expect(q('[data-contract-differs]')).toBeNull()
    await clickMeasure('box')
    const flagged = [...document.querySelectorAll('[data-contract-differs]')].map((el) =>
      el.getAttribute('data-contract-differs')
    )
    expect(flagged.sort()).toEqual(['box@def', 'laptop@abc'])
    expect(document.querySelectorAll('[data-prepare-contract-source]').length).toBe(2)
  })

  it('does not flag two hosts that hold the same contract', async () => {
    hoisted.blocks = [LAPTOP, BOX]
    hoisted.measure = vi.fn().mockImplementation((_target: unknown, repoId: string) =>
      Promise.resolve({
        status: 'measured',
        result: measurementFor(repoId === 'r1' ? 'laptop@abc' : 'box@def', HASH_A)
      })
    )
    await renderSection()
    await clickMeasure('laptop')
    await clickMeasure('box')
    expect(document.querySelectorAll('[data-prepare-contract-source]').length).toBe(2)
    expect(q('[data-contract-differs]')).toBeNull()
  })

  it('says so when a host cannot be measured', async () => {
    hoisted.measure = vi.fn().mockRejectedValue(new Error('raw transport text'))
    await renderSection()
    await clickMeasure('laptop')
    const failed = q('[data-prepare-measure-failed]')
    expect(failed).not.toBeNull()
    expect(failed?.textContent).not.toContain('raw transport text')
    expect(q('[data-requirement-id]')).toBeNull()
  })

  it('names an old host in words', async () => {
    hoisted.measure = vi
      .fn()
      .mockResolvedValue({ status: 'host-predates-probes', detail: 'method-not-found' })
    await renderSection()
    await clickMeasure('laptop')
    expect(q('[data-prepare-host-predates]')).not.toBeNull()
    expect(q('[data-requirement-id]')).toBeNull()
  })

  it('says an absent contract declares no requirements', async () => {
    hoisted.measure = vi.fn().mockResolvedValue({
      status: 'measured',
      result: { ...measurementFor('laptop@abc', HASH_A, 'absent'), requirements: [] }
    })
    await renderSection()
    await clickMeasure('laptop')
    expect(q('[data-prepare-host-block="laptop"]')?.textContent).toContain(
      'No requirements declared'
    )
  })

  it('states an unreadable contract as unknown by name', async () => {
    hoisted.measure = vi.fn().mockResolvedValue({
      status: 'measured',
      result: { ...measurementFor('laptop@abc', HASH_A, 'unreadable'), requirements: [] }
    })
    await renderSection()
    await clickMeasure('laptop')
    const row = q('[data-requirement-id="orca.yaml"]')
    expect(row?.getAttribute('data-requirement-state')).toBe('unknown')
    expect(row?.getAttribute('data-requirement-reason')).toBe('contract-unreadable')
  })
})
