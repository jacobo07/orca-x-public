import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { isMethodAllowedWhileObserveOnly } from '../observe-only-mode'
import { RpcDispatcher } from './dispatcher'

const dirs: string[] = []

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-ws-method-'))
  dirs.push(dir)
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 'a@b.c')
  run('config', 'user.name', 'a')
  writeFileSync(join(dir, 'a.txt'), 'x')
  run('add', 'a.txt')
  run('commit', '-q', '-m', 'first')
  run('remote', 'add', 'origin', 'git@github.com:a/b.git')
  return dir
}

function rig(runtime: OrcaRuntimeService, path: string, connectionId?: string): OrcaRuntimeService {
  vi.spyOn(runtime, 'listManagedWorktrees').mockResolvedValue({
    worktrees: [{ id: 'r::w', repoId: 'r', instanceId: 'i', path }],
    totalCount: 1,
    truncated: false
  } as never)
  vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'r', connectionId } as never)
  return runtime
}

function ask(
  runtime: OrcaRuntimeService
): Promise<{ ok: boolean; result: Record<string, unknown> }> {
  return new RpcDispatcher({ runtime }).dispatch({
    id: 'req',
    authToken: 'local',
    method: 'workspace.placements',
    params: {}
  } as never) as never
}

describe('workspace.placements', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers through the real dispatcher with real git', async () => {
    const path = repo()
    const runtime = new OrcaRuntimeService()
    const reply = await ask(rig(runtime, path))

    expect(reply).toMatchObject({
      ok: true,
      result: {
        truncated: false,
        unavailable: [],
        placements: [{ repoKey: 'github.com/a/b', lineageKey: 'branch:main' }]
      }
    })
  })

  it('refuses a worktree of an SSH repository, even if the path exists here', async () => {
    const path = repo()
    const runtime = new OrcaRuntimeService()
    rig(runtime, path, 'conn-1')

    const reply = await ask(runtime)

    expect(reply).toMatchObject({
      result: { placements: [], unavailable: [{ unavailable: 'remote_repo_unsupported' }] }
    })
  })

  it('treats a repository it cannot identify as remote', async () => {
    const path = repo()
    const runtime = new OrcaRuntimeService()
    rig(runtime, path)
    vi.spyOn(runtime, 'showRepo').mockRejectedValue(new Error('repo_not_found'))

    const reply = await ask(runtime)

    expect(reply).toMatchObject({
      result: { placements: [], unavailable: [{ unavailable: 'remote_repo_unsupported' }] }
    })
  })

  it('joins repeated reads instead of running git again', async () => {
    const path = repo()
    const runtime = new OrcaRuntimeService()
    const list = vi.spyOn(rig(runtime, path), 'listManagedWorktrees')

    await ask(runtime)
    await ask(runtime)

    expect(list).toHaveBeenCalledOnce()
  })

  it('stays readable on an observe-only host', () => {
    expect(isMethodAllowedWhileObserveOnly('workspace.placements')).toBe(true)
  })
})
