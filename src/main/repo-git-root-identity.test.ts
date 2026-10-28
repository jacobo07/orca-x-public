import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_ROOT_PROBE_ARGV } from '../shared/git-root-identity'
import { gitExecFileAsync } from './git/runner'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import { probeGitRootIdentity } from './repo-git-root-identity'

vi.mock('./git/runner', () => ({ gitExecFileAsync: vi.fn() }))
vi.mock('./providers/ssh-git-dispatch', () => ({ getSshGitProvider: vi.fn() }))

const SHA = 'c'.repeat(40)
const out = (stdout: string) => ({ stdout, stderr: '' })

beforeEach(() => {
  vi.resetAllMocks()
})

describe('probeGitRootIdentity', () => {
  it('sends exactly the exported argv, in order, to the local runner', async () => {
    vi.mocked(gitExecFileAsync)
      .mockResolvedValueOnce(out('false\n.git\n'))
      .mockResolvedValueOnce(out(`${SHA}\n`))

    await expect(probeGitRootIdentity('/repos/orca')).resolves.toEqual({
      status: 'resolved',
      identity: { rootCommit: SHA, commonDir: '/repos/orca/.git', shallow: false }
    })
    expect(vi.mocked(gitExecFileAsync).mock.calls).toEqual([
      [[...GIT_ROOT_PROBE_ARGV.shallowAndCommonDir], { cwd: '/repos/orca' }],
      [[...GIT_ROOT_PROBE_ARGV.firstParentRoot], { cwd: '/repos/orca' }]
    ])
  })

  it('settles unborn when the root step fails and no ref exists', async () => {
    vi.mocked(gitExecFileAsync)
      .mockResolvedValueOnce(out('false\n.git\n'))
      .mockRejectedValueOnce(new Error('fatal: your current branch does not have any commits'))
      .mockResolvedValueOnce(out(''))

    await expect(probeGitRootIdentity('/repos/new')).resolves.toEqual({
      status: 'settled-none',
      reason: 'unborn'
    })
    expect(vi.mocked(gitExecFileAsync).mock.calls[2]?.[0]).toEqual([...GIT_ROOT_PROBE_ARGV.anyRef])
  })

  it('stays unavailable when the root step fails and a ref exists', async () => {
    vi.mocked(gitExecFileAsync)
      .mockResolvedValueOnce(out('false\n.git\n'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(out(`${SHA}\n`))

    await expect(probeGitRootIdentity('/repos/odd')).resolves.toEqual({ status: 'unavailable' })
  })

  it('settles shallow without a second command', async () => {
    vi.mocked(gitExecFileAsync).mockResolvedValueOnce(out('true\n.git\n'))

    await expect(probeGitRootIdentity('/repos/clone')).resolves.toEqual({
      status: 'settled-none',
      reason: 'shallow'
    })
    expect(gitExecFileAsync).toHaveBeenCalledTimes(1)
  })

  it('never throws when the first command fails', async () => {
    vi.mocked(gitExecFileAsync).mockRejectedValue(new Error('not a git repository'))

    await expect(probeGitRootIdentity('/repos/none')).resolves.toEqual({ status: 'unavailable' })
  })

  it('is unavailable when the SSH host has no connected git provider', async () => {
    vi.mocked(getSshGitProvider).mockReturnValue(undefined)

    await expect(probeGitRootIdentity('/repos/orca', 'builder')).resolves.toEqual({
      status: 'unavailable'
    })
    expect(gitExecFileAsync).not.toHaveBeenCalled()
  })

  it('resolves an SSH relative common dir with posix semantics', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(out('false\n.git\n'))
      .mockResolvedValueOnce(out(`${SHA}\n`))
    vi.mocked(getSshGitProvider).mockReturnValue({ exec } as never)

    await expect(probeGitRootIdentity('/home/me/proj', 'builder')).resolves.toEqual({
      status: 'resolved',
      identity: { rootCommit: SHA, commonDir: '/home/me/proj/.git', shallow: false }
    })
    expect(exec).toHaveBeenNthCalledWith(
      1,
      [...GIT_ROOT_PROBE_ARGV.shallowAndCommonDir],
      '/home/me/proj'
    )
    expect(gitExecFileAsync).not.toHaveBeenCalled()
  })
})
