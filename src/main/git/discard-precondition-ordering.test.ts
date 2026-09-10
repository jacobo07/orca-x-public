import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './runner'
import { discardChanges, readWorktreeContentIdentity, StaleWorktreeStateError } from './status'

/**
 * The precondition claims to sit "as close to the destruction as the code allows". It did not: a
 * `ls-files` subprocess ran between the check and the `restore`, and on the relay leg an entire
 * second method did. Any write landing in that window was destroyed under a green precondition.
 *
 * A real race cannot prove this deterministically, so the probe IS the window here -- the mocked
 * `ls-files` performs the write. That models any actor whose write happens to land there, and it
 * fails or passes for ordering reasons alone.
 *
 * Only the git subprocess is doubled. The precondition reads a real file off a real disk, so the
 * behaviour under test is the genuine one; the sibling real-git suite covers everything else.
 */
vi.mock('./runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runner')>()),
  gitExecFileAsync: vi.fn()
}))

const execMock = vi.mocked(gitExecFileAsync)
const tempRoots: string[] = []
let repo = ''

function subcommands(): string[] {
  return execMock.mock.calls.map(([args]) => args[0] ?? '')
}

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-discard-window-'))
  tempRoots.push(root)
  repo = path.join(root, 'repo')
  await mkdir(repo, { recursive: true })
  execMock.mockReset()
})

afterEach(async () => {
  while (tempRoots.length > 0) {
    await rm(tempRoots.pop() as string, { recursive: true, force: true })
  }
})

describe('discard precondition ordering', () => {
  it('refuses the discard when the file changes between the tracked probe and the destructive write', async () => {
    await writeFile(path.join(repo, 'note.txt'), 'authorized')
    const authorized = await readWorktreeContentIdentity(repo, 'note.txt')

    execMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ls-files') {
        await writeFile(path.join(repo, 'note.txt'), 'written during the window')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      discardChanges(repo, 'note.txt', {}, { expectedContent: authorized })
    ).rejects.toBeInstanceOf(StaleWorktreeStateError)

    expect(subcommands()).not.toContain('restore')
    expect(await readFile(path.join(repo, 'note.txt'), 'utf8')).toBe('written during the window')
  })

  // The control that makes the case above mean something: the same harness must let an undisturbed
  // discard through, or a rejection would prove only that the mock is broken.
  it('still discards when nothing writes during the window', async () => {
    await writeFile(path.join(repo, 'note.txt'), 'authorized')
    const authorized = await readWorktreeContentIdentity(repo, 'note.txt')
    execMock.mockResolvedValue({ stdout: '', stderr: '' })

    await expect(
      discardChanges(repo, 'note.txt', {}, { expectedContent: authorized })
    ).resolves.toBeUndefined()

    expect(subcommands()).toContain('restore')
  })
})
