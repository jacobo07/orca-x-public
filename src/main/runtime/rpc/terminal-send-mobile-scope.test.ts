import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { RuntimeTerminalRead } from '../../../shared/runtime-types'
import { judgeFreshTerminalOutput } from '../../../shared/terminal-fresh-output-oracle'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

const REPO_ID = 'repo-mobile-scope'
const WORKTREE_PATH = '/tmp/mobile-scope'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const TAB_ID = 'tab-mobile-scope'
const OLDER_LEAF = '11111111-1111-4111-8111-111111111111'
const NEWER_LEAF = '33333333-3333-4333-8333-333333333333'
const OLDER_PTY = 'pty-mobile-scope-older'
const NEWER_PTY = 'pty-mobile-scope-newer'
const MARKER = 'ORCA-PHONE-MARKER-2c8e'

function makeSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: OLDER_PTY,
          worktreeId: WORKTREE_ID,
          title: 'Scope shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: OLDER_LEAF },
          second: { type: 'leaf', leafId: NEWER_LEAF }
        },
        activeLeafId: NEWER_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [OLDER_LEAF]: OLDER_PTY, [NEWER_LEAF]: NEWER_PTY }
      }
    },
    terminalPtyIncarnationsByPaneKey: {
      [makePaneKey(TAB_ID, OLDER_LEAF)]: '22222222-2222-4222-8222-222222222222',
      [makePaneKey(TAB_ID, NEWER_LEAF)]: '44444444-4444-4444-8444-444444444444'
    }
  }
}

/** One host: a real runtime behind the real terminal RPC methods, with a shell that runs `echo`. */
function createHost() {
  let session = makeSession()
  const repo = {
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'scope',
    badgeColor: '#000000',
    addedAt: 1
  }
  const store = {
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getProjects: () => [],
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  }
  const written = new Map<string, string>()
  const runtime = new OrcaRuntimeService(store as never)
  let now = 1_000
  // Why: a fake shell that echoes input and executes `echo A' 'B` so output differs from input.
  const shell = (ptyId: string, data: string): void => {
    const pending = (written.get(ptyId) ?? '') + data
    written.set(ptyId, pending)
    if (!data.includes('\r')) {
      return
    }
    const line = pending.slice(pending.lastIndexOf('\n') + 1).replace(/\r$/, '')
    const echo = /^echo (\S+)' '(\S+)$/.exec(line)
    const output = echo ? `${echo[1]} ${echo[2]}\r\n` : ''
    written.set(ptyId, `${pending}\n`)
    queueMicrotask(() => runtime.onPtyData(ptyId, `$ ${line}\r\n${output}`, (now += 10)))
  }
  runtime.setPtyController({
    write: (ptyId: string, data: string) => {
      shell(ptyId, data)
      return true
    },
    kill: () => true,
    listProcesses: async () => [],
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Scope shell',
        activeLeafId: NEWER_LEAF,
        layout: session.terminalLayoutsByTabId[TAB_ID]!.root
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: OLDER_LEAF,
        paneRuntimeId: 7,
        ptyId: OLDER_PTY
      },
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: NEWER_LEAF,
        paneRuntimeId: 8,
        ptyId: NEWER_PTY
      }
    ]
  })
  runtime.onPtyData(OLDER_PTY, '$ ls\r\nREADME.md\r\n', 100)
  runtime.onPtyData(NEWER_PTY, '$ pwd\r\n/tmp/mobile-scope\r\n', 200)
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  let requestSeq = 0
  const call = (method: string, params: unknown) =>
    dispatcher.dispatch({
      id: `req-${++requestSeq}`,
      authToken: 'tok',
      method,
      params
    } as RpcRequest)
  const handleFor = async (ptyId: string): Promise<string> => {
    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    const terminal = terminals.find((candidate) => candidate.ptyId === ptyId)
    if (!terminal) {
      throw new Error(`no terminal for ${ptyId}`)
    }
    return terminal.handle
  }
  const read = async (handle: string, cursor?: string): Promise<RuntimeTerminalRead> => {
    const response = await call('terminal.read', {
      terminal: handle,
      ...(cursor !== undefined ? { cursor: Number(cursor) } : {})
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return (response.result as { terminal: RuntimeTerminalRead }).terminal
  }
  return { runtime, call, handleFor, read, written }
}

/** The mobile send shape from mobile/src/terminal/terminal-send-request.ts (clientless: no device token). */
function mobileSend(terminal: string, text: string) {
  return { terminal, text, enter: true }
}

async function sendAndJudge(host: ReturnType<typeof createHost>, handle: string, nonce: string) {
  const sentText = `echo ${MARKER}' '${nonce}`
  const before = await host.read(handle)
  const response = await host.call('terminal.send', mobileSend(handle, sentText))
  await new Promise((settle) => setTimeout(settle, 0))
  const after = await host.read(handle, before.latestCursor)
  return {
    response,
    judgement: judgeFreshTerminalOutput({ handle, marker: MARKER, nonce, sentText, before, after })
  }
}

describe('mobile terminal.send scope, proven by fresh output', () => {
  it('reaches exactly the addressed PTY and is proven FRESH there', async () => {
    const host = createHost()
    const older = await host.handleFor(OLDER_PTY)

    const { response, judgement } = await sendAndJudge(host, older, 'nonce-older-1')

    expect(response.ok).toBe(true)
    expect(judgement).toEqual({ verdict: 'FRESH' })
    // Newest-terminal mutant: the active, newer pane must receive zero bytes.
    expect(host.written.get(NEWER_PTY)).toBeUndefined()
    expect(host.written.get(OLDER_PTY)).toContain('nonce-older-1')
  })

  it('does not satisfy the oracle on the sibling pane the send did not address', async () => {
    const host = createHost()
    const older = await host.handleFor(OLDER_PTY)
    const newer = await host.handleFor(NEWER_PTY)
    const sentText = `echo ${MARKER}' 'nonce-sibling-2`
    const siblingBefore = await host.read(newer)

    await host.call('terminal.send', mobileSend(older, sentText))
    await new Promise((settle) => setTimeout(settle, 0))
    const siblingAfter = await host.read(newer, siblingBefore.latestCursor)

    expect(
      judgeFreshTerminalOutput({
        handle: newer,
        marker: MARKER,
        nonce: 'nonce-sibling-2',
        sentText,
        before: siblingBefore,
        after: siblingAfter
      }).verdict
    ).toBe('ABSENT')
  })

  it('refuses a handle minted by a different host (runtime) and writes nothing there', async () => {
    const hostA = createHost()
    const hostB = createHost()
    const handleFromA = await hostA.handleFor(OLDER_PTY)

    const response = await hostB.call(
      'terminal.send',
      mobileSend(handleFromA, `echo ${MARKER}' 'x`)
    )

    expect(response.ok).toBe(false)
    if (response.ok) {
      throw new Error('expected refusal')
    }
    expect(response.error.message).toContain('terminal_handle_stale')
    expect(hostB.written.size).toBe(0)
  })

  it('refuses a stale-generation handle after the pane PTY is replaced and writes nothing', async () => {
    const host = createHost()
    const older = await host.handleFor(OLDER_PTY)
    const internals = host.runtime as unknown as {
      leaves: Map<string, { ptyId: string | null; ptyGeneration?: number }>
    }
    for (const leaf of internals.leaves.values()) {
      if (leaf.ptyId === OLDER_PTY) {
        leaf.ptyGeneration = (leaf.ptyGeneration ?? 0) + 1
      }
    }

    const response = await host.call('terminal.send', mobileSend(older, `echo ${MARKER}' 'stale`))

    expect(response.ok).toBe(false)
    if (response.ok) {
      throw new Error('expected refusal')
    }
    expect(response.error.message).toContain('terminal_handle_stale')
    expect(host.written.size).toBe(0)
  })
})

function bumpGeneration(host: ReturnType<typeof createHost>, ptyId: string): void {
  const internals = host.runtime as unknown as {
    leaves: Map<string, { ptyId: string | null; ptyGeneration?: number }>
  }
  for (const leaf of internals.leaves.values()) {
    if (leaf.ptyId === ptyId) {
      leaf.ptyGeneration = (leaf.ptyGeneration ?? 0) + 1
    }
  }
}

const PHONE = { id: 'phone-1', type: 'mobile' as const }
const DESK = { id: 'desk-1', type: 'desktop' as const }

describe('stale writes and the current controller across client classes (DWS rows 33/39, Orca half)', () => {
  it('refuses a stale desktop write exactly as it refuses a stale mobile write', async () => {
    const host = createHost()
    const older = await host.handleFor(OLDER_PTY)
    bumpGeneration(host, OLDER_PTY)

    const desktop = await host.call('terminal.send', {
      terminal: older,
      text: `echo ${MARKER}' 'desk-stale`,
      enter: true,
      client: DESK
    })
    const mobile = await host.call('terminal.send', {
      terminal: older,
      text: `echo ${MARKER}' 'phone-stale`,
      enter: true,
      client: PHONE
    })

    for (const response of [desktop, mobile]) {
      expect(response.ok).toBe(false)
      if (response.ok) {
        throw new Error('expected refusal')
      }
      expect(response.error.message).toContain('terminal_handle_stale')
    }
    expect(host.written.size).toBe(0)
  })

  it('accepts the controlling phone and refuses the desktop while the phone holds the floor', async () => {
    const host = createHost()
    const older = await host.handleFor(OLDER_PTY)
    // No viewport: registers the subscriber without a resize (returns false by design).
    await host.runtime.handleMobileSubscribe(OLDER_PTY, PHONE.id)

    const phoneText = `echo ${MARKER}' 'phone-first`
    const before = await host.read(older)
    const phone = await host.call('terminal.send', {
      terminal: older,
      text: phoneText,
      enter: true,
      client: PHONE
    })
    await new Promise((settle) => setTimeout(settle, 0))
    expect(phone).toMatchObject({ ok: true, result: { send: { accepted: true } } })
    expect(
      judgeFreshTerminalOutput({
        handle: older,
        marker: MARKER,
        nonce: 'phone-first',
        sentText: phoneText,
        before,
        after: await host.read(older, before.latestCursor)
      })
    ).toEqual({ verdict: 'FRESH' })
    expect(host.runtime.getDriver(OLDER_PTY)).toMatchObject({ kind: 'mobile', clientId: PHONE.id })

    const bytesBeforeDesktop = host.written.get(OLDER_PTY)
    const desktop = await host.call('terminal.send', {
      terminal: older,
      text: `echo ${MARKER}' 'desk-intrudes`,
      enter: true,
      client: DESK
    })
    expect(desktop).toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0 } }
    })
    expect(host.written.get(OLDER_PTY)).toBe(bytesBeforeDesktop)
  })
})
