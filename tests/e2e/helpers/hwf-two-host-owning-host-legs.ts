import { randomBytes } from 'node:crypto'
import path from 'node:path'

import { expect, type Page } from '@stablyai/playwright-test'

import type { SshMutationExpectation } from '../../../src/shared/ssh-types'
import { execOnOwningHost, type HwfRun } from './hwf-two-host-ssh-target'
import {
  execInTerminal,
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForTerminalOutput
} from './terminal'

export type HwfLegWorktree = { id: string; path: string }

function lastLine(out: string): string {
  const lines = out.trim().split(/\r?\n/)
  return (lines.at(-1) ?? '').trim()
}

// Why: every client-reported effect is re-read by ssh inside the root; only a `yes` from the host counts.
function hostSaysYes(run: HwfRun, script: string): boolean {
  const result = execOnOwningHost(run, script)
  return result.status === 0 && lastLine(result.out) === 'yes'
}

function hostRead(run: HwfRun, script: string): string {
  const result = execOnOwningHost(run, script)
  expect(result.status).toBe(0)
  return lastLine(result.out)
}

// Shape from nested-runtime-ssh-routing.spec.ts assertWebTerminal, driven by the store: this web client's worktree list is not mounted on its landing surface.
export async function activateWebSshWorktree(page: Page, worktreeId: string): Promise<void> {
  let lastClick = 0
  await expect
    .poll(
      async () => {
        const state = await page.evaluate((id) => {
          const current = window.__store?.getState()
          const tabs = current?.tabsByWorktree[id] ?? []
          return {
            active: current?.activeWorktreeId === id,
            bound: tabs.some((tab) => (current?.ptyIdsByTabId[tab.id] ?? []).length > 0)
          }
        }, worktreeId)
        const now = Date.now()
        if ((!state.active || !state.bound) && now - lastClick >= 2_000) {
          lastClick = now
          await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
        }
        return state.active && state.bound ? worktreeId : null
      },
      { timeout: 30_000, intervals: [100, 250, 500, 1_000], message: 'web terminal never bound' }
    )
    .toBe(worktreeId)
  await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
    'data-rendered-active-worktree-id',
    worktreeId
  )
}

export async function assertTerminalOnOwningHost(
  page: Page,
  run: HwfRun,
  label: string,
  input: 'pty-write' | 'keyboard'
): Promise<{ host: string; pwd: string }> {
  const ptyId = await waitForActivePanePtyId(page, 45_000)
  const nonce = randomBytes(4).toString('hex')
  const head = `HWF_T${label}_${nonce.slice(0, 3)}`
  const tail = nonce.slice(3)
  // Why: the typed command never contains the joined marker, so only real output can satisfy the wait.
  const command = `printf '%s%s host=%s pwd=%s\\n' '${head}' '${tail}' "$(hostname)" "$(pwd)"`
  const joined = `HWF_T${label}_${nonce}`
  // Why: a keystroke typed before the remote shell is ready is dropped without a trace, so a bounded retype is the readiness wait.
  for (let attempt = 1; ; attempt += 1) {
    if (input === 'pty-write') {
      await execInTerminal(page, ptyId, command)
    } else {
      await focusActiveTerminalInput(page)
      await page.keyboard.insertText(command)
      await page.keyboard.press('Enter')
    }
    try {
      await waitForTerminalOutput(page, `${joined} host=`, attempt < 3 ? 15_000 : 30_000)
      break
    } catch (error) {
      if (attempt >= 3) {
        throw error
      }
      console.log(`HWF_TERMINAL_${label}_RETYPE attempt=${attempt}`)
    }
  }
  const content = await getTerminalContent(page, 8000)
  const match = new RegExp(`${joined} host=(\\S+) pwd=(\\S+)`).exec(content)
  expect(match).not.toBeNull()
  const [, host, pwd] = match!
  expect(host).toBe(run.hostname)
  expect(pwd.startsWith(`${run.root}/`)).toBe(true)
  console.log(`HWF_TERMINAL_${label} host=${host} pwd=${pwd}`)
  return { host, pwd }
}

export type HwfSshAuth = { connectionId: string; executionHostId: `ssh:${string}` }

// Client A passes the provenance triple; Client B (web) passes none, as the web client does.
export async function assertFsMutationsOnOwningHost(
  page: Page,
  run: HwfRun,
  worktree: HwfLegWorktree,
  auth: HwfSshAuth | null,
  label: string
): Promise<string> {
  const content = `HWF_FS_${label}_${randomBytes(8).toString('hex')}`
  const dir = path.posix.join(worktree.path, `hwf-fs-${label}-${Date.now().toString(36)}`)
  const source = path.posix.join(dir, 'source.txt')
  const renamed = path.posix.join(dir, 'renamed.txt')
  const copied = path.posix.join(dir, 'copied.txt')
  const paths = { dir, source, renamed, copied }

  await page.evaluate(
    async ({ paths, content, auth }) => {
      let base: SshMutationExpectation & { connectionId?: string } = {}
      if (auth) {
        const state = await window.api.ssh.getState({ targetId: auth.connectionId })
        base = {
          connectionId: auth.connectionId,
          expectedExecutionHostId: auth.executionHostId,
          expectedSshTargetId: auth.connectionId,
          expectedSshConnectionGeneration: state?.connectionGeneration
        }
      }
      await window.api.fs.createDir({ dirPath: paths.dir, ...base })
      await window.api.fs.createFile({ filePath: paths.source, ...base })
      await window.api.fs.writeFile({ filePath: paths.source, content, ...base })
      await window.api.fs.rename({ oldPath: paths.source, newPath: paths.renamed, ...base })
      await window.api.fs.copy({
        sourcePath: paths.renamed,
        destinationPath: paths.copied,
        ...base
      })
    },
    { paths, content, auth }
  )
  expect(
    hostSaysYes(
      run,
      `[ "$(cat '${renamed}')" = '${content}' ] && [ "$(cat '${copied}')" = '${content}' ] && [ ! -e '${source}' ] && echo yes`
    )
  ).toBe(true)

  await page.evaluate(
    async ({ paths, auth }) => {
      const base = auth
        ? {
            connectionId: auth.connectionId,
            expectedExecutionHostId: auth.executionHostId,
            expectedSshTargetId: auth.connectionId,
            expectedSshConnectionGeneration: (
              await window.api.ssh.getState({ targetId: auth.connectionId })
            )?.connectionGeneration
          }
        : {}
      await window.api.fs.deletePath({ targetPath: paths.copied, ...base })
      await window.api.fs.deletePath({ targetPath: paths.renamed, ...base })
      await window.api.fs.deletePath({ targetPath: paths.dir, recursive: true, ...base })
    },
    { paths, auth }
  )
  expect(hostSaysYes(run, `[ ! -e '${dir}' ] && echo yes`)).toBe(true)
  console.log(`HWF_FS_${label}=ok`)
  return content
}

export async function assertGitCommitOnOwningHost(
  page: Page,
  run: HwfRun,
  worktree: HwfLegWorktree,
  auth: HwfSshAuth | null,
  label: string
): Promise<{ sha: string; contentNonce: string }> {
  const contentNonce = `HWF_GIT_${label}_${randomBytes(8).toString('hex')}`
  const fileName = `hwf-git-${label}-${Date.now().toString(36)}.txt`
  const message = `hwf p15 ${label} ${randomBytes(4).toString('hex')}`
  const headBefore = hostRead(run, `git -C '${run.repo}' rev-parse HEAD`)

  const reported = await page.evaluate(
    async ({ worktree, auth, fileName, contentNonce, message }) => {
      const conn = auth ? { connectionId: auth.connectionId } : {}
      // Provenance triple on the fs writes, as in the fs leg; git calls carry the connection only.
      const fsBase = auth
        ? {
            ...conn,
            expectedExecutionHostId: auth.executionHostId,
            expectedSshTargetId: auth.connectionId,
            expectedSshConnectionGeneration: (
              await window.api.ssh.getState({ targetId: auth.connectionId })
            )?.connectionGeneration
          }
        : {}
      const filePath = `${worktree.path}/${fileName}`
      await window.api.fs.createFile({ filePath, ...fsBase })
      await window.api.fs.writeFile({ filePath, content: contentNonce, ...fsBase })
      await window.api.git.status({ worktreePath: worktree.path, ...conn })
      // Why: the desktop IPC takes a worktree-relative path; the paired web shim rejects it as outside the runtime worktree and wants the absolute one (measured).
      await window.api.git.stage({
        worktreePath: worktree.path,
        filePath: auth ? fileName : filePath,
        ...conn
      })
      const commit = await window.api.git.commit({ worktreePath: worktree.path, message, ...conn })
      const history = await window.api.git.history({
        worktreePath: worktree.path,
        limit: 5,
        ...conn
      })
      return {
        commit,
        headId: history.items[0]?.id ?? '',
        subject: history.items[0]?.subject ?? ''
      }
    },
    { worktree, auth, fileName, contentNonce, message }
  )
  expect(reported.commit.success, JSON.stringify(reported.commit)).toBe(true)

  const remoteHead = hostRead(run, `git -C '${run.repo}' rev-parse HEAD`)
  const remoteSubject = hostRead(run, `git -C '${run.repo}' log -1 --format=%s`)
  expect(remoteHead).not.toBe(headBefore)
  expect(remoteSubject).toBe(message)
  expect(hostRead(run, `git -C '${run.repo}' show 'HEAD:${fileName}'`)).toBe(contentNonce)
  expect(reported.headId).toBe(remoteHead)
  console.log(`HWF_GIT_${label} sha=${reported.headId} remote=${remoteHead}`)
  return { sha: remoteHead, contentNonce }
}
