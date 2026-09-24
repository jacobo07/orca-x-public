// Rung 2: the whole remote-turn path in one process, with nothing faked but the ssh wire itself.
//
// A REAL relay dispatcher and the REAL agentProcess handler spawn a REAL child; a REAL multiplexer
// talks to them over an in-memory transport; the ssh adapter and the unchanged local app-server
// session drive a real Codex conversation driver through it. The child is a scripted app-server:
// "codex" resolves to this node, and `app-server` is a script file of that name in the project
// directory, so `node app-server` is what runs — in the directory the turn was located in.

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import { RelayDispatcher } from '../../relay/dispatcher'
import { AgentProcessHandler } from '../../relay/agent-process-handler'
import { SshChannelMultiplexer, type MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'

import { runCodexAppServerSession } from './codex-app-server-session'
import { createCodexConversationDriver } from './codex-conversation-driver'
import { createSshAgentProcessSpawn } from './codex-ssh-agent-process'

const SCRIPTED_APP_SERVER = String.raw`
const fs = require('fs')
fs.writeFileSync('pid.txt', String(process.pid))
const hang = fs.existsSync('hang.flag')
let buffer = ''
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const waiting = new Map()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => process.exit(0))
function handle(message) {
  if (message.id !== undefined && !message.method) {
    const resolve = waiting.get(message.id)
    if (resolve) { waiting.delete(message.id); resolve(message) }
    return
  }
  if (message.method === 'initialize') return send({ id: message.id, result: {} })
  if (message.method === 'thread/start') {
    return send({ id: message.id, result: { thread: { id: 'thr-remote', cwd: process.cwd() } } })
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } })
    return runTurn()
  }
}
async function runTurn() {
  send({ method: 'turn/started', params: { turn: { id: 'turn-1' } } })
  if (hang) return
  const answer = await new Promise((resolve) => {
    waiting.set('srv-1', resolve)
    send({ id: 'srv-1', method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thr-remote', turnId: 'turn-1', itemId: 'cmd-1', command: 'ls' } })
  })
  fs.writeFileSync('approval.json', JSON.stringify(answer))
  const burst = 'x'.repeat(200 * 1024)
  send({ method: 'item/agentMessage/delta', params: { itemId: 'msg-1', turnId: 'turn-1', delta: burst } })
  send({ method: 'item/completed', params: { item: { id: 'msg-1', type: 'agentMessage', text: 'cwd=' + process.cwd() } } })
  send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })
}
`

type Harness = {
  dispatcher: RelayDispatcher
  mux: SshChannelMultiplexer
  handler: AgentProcessHandler
}

function createHarness(realHost = false): Harness {
  let relayFeed: ((data: Buffer) => void) | undefined
  const clientDataCallbacks: ((data: Buffer) => void)[] = []
  const transport: MultiplexerTransport = {
    write: (data, onSettled) => {
      setImmediate(() => {
        relayFeed?.(data)
        onSettled?.({ ok: true })
      })
    },
    supportsWriteSettlement: true,
    onData: (cb) => {
      clientDataCallbacks.push(cb)
    },
    onClose: () => {}
  }
  const dispatcher = new RelayDispatcher(
    (data: Buffer, onSettled) => {
      setImmediate(() => {
        for (const cb of clientDataCallbacks) {
          cb(data)
        }
        onSettled({ ok: true })
      })
    },
    { supportsWriteCallback: true }
  )
  relayFeed = (data) => dispatcher.feed(data)
  // The handler refuses Windows hosts; this test host may be Windows, and the refusal is not what
  // it is proving. Everything else — spawn, streams, kill — is the real code.
  const handler = new AgentProcessHandler(
    dispatcher,
    realHost ? {} : { resolveCommand: async () => process.execPath, platform: 'linux' }
  )
  return { dispatcher, mux: new SshChannelMultiplexer(transport), handler }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

let project = ''
let harness: Harness

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'orca-remote-project-'))
  writeFileSync(join(project, 'app-server'), SCRIPTED_APP_SERVER)
  harness = createHarness()
})

afterEach(async () => {
  await harness.handler.dispose()
  harness.mux.dispose()
  rmSync(project, { recursive: true, force: true })
})

function remoteDriver(timeoutMs: number) {
  return createCodexConversationDriver({
    command: 'codex',
    timeoutMs,
    runSession: (invocation, body, _spawn, handlers) =>
      runCodexAppServerSession(
        { ...invocation, exitGraceMs: 5_000 },
        body,
        createSshAgentProcessSpawn(harness.mux, {
          cwd: project,
          deadlineMs: timeoutMs
        }) as never,
        handlers
      )
  })
}

describe('a remote turn through the real relay handler and a real child', () => {
  it('completes a turn in the located directory, answers the approval, survives a burst, and reaps the child', async () => {
    const events: AgentTurnEvent[] = []

    const result = await remoteDriver(60_000).runTurn({
      resumeSessionId: null,
      cwd: project,
      text: 'what is here?',
      developerInstructions: null,
      turnId: 'turn-local-1',
      onEvent: (event) => events.push(event)
    })

    expect(result.providerSessionId).toBe('thr-remote')
    expect(events.map((event) => event.kind)).toContain('turn-completed')
    const deltas = events.filter((event) => event.kind === 'assistant-delta')
    expect(deltas.map((event) => (event as { text: string }).text).join('')).toHaveLength(
      200 * 1024
    )
    const completed = events.find(
      (event) => event.kind === 'message-completed' && event.role === 'assistant'
    ) as { blocks?: { type: string; text?: string }[] } | undefined
    // The provider ran in the project directory the turn was located in, not wherever Orca runs.
    expect(completed?.blocks?.[0]?.text?.toLowerCase()).toBe(`cwd=${project}`.toLowerCase())
    // The server->client request crossed the relay both ways and was answered.
    expect(JSON.parse(readFileSync(join(project, 'approval.json'), 'utf8'))).toMatchObject({
      id: 'srv-1'
    })

    const pid = Number(readFileSync(join(project, 'pid.txt'), 'utf8'))
    expect(await waitUntil(() => !isAlive(pid), 10_000)).toBe(true)
  }, 90_000)

  it('kills the remote child when the session deadline lapses mid-turn', async () => {
    writeFileSync(join(project, 'hang.flag'), '1')

    const outcome = await remoteDriver(4_000)
      .runTurn({
        resumeSessionId: null,
        cwd: project,
        text: 'hang',
        developerInstructions: null,
        turnId: 'turn-local-2',
        onEvent: () => {}
      })
      .then(
        () => 'returned',
        (error: Error) => error.name
      )

    expect(outcome).not.toBe('returned')
    const pid = Number(readFileSync(join(project, 'pid.txt'), 'utf8'))
    expect(await waitUntil(() => !isAlive(pid), 10_000)).toBe(true)
  }, 60_000)
})

/** The executable of every process whose working directory is `dir`, read from the kernel. */
function processesIn(dir: string): string[] {
  const real = realpathSync(dir)
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      try {
        return readlinkSync(`/proc/${name}/cwd`) === real
          ? [readlinkSync(`/proc/${name}/exe`)]
          : []
      } catch {
        // Exited between the listing and the read, or not ours to inspect.
        return []
      }
    })
}

// Rung 3, opt-in: the installed Codex CLI on a Linux host, with the host deps unreplaced — real
// command resolution, spawn and group kill. Needs no login: `thread/start` answers without a model.
describe.skipIf(process.platform !== 'linux' || process.env.ORCA_REAL_CODEX_RUNG !== '1')(
  'a real codex app-server through the relay handler',
  () => {
    it('runs in the located directory, reports it, and leaves no process behind', async () => {
      const real = createHarness(true)
      const home = mkdtempSync(join(tmpdir(), 'orca-isolated-codex-home-'))
      try {
        const observed = await runCodexAppServerSession(
          { command: 'codex', args: ['app-server'], timeoutMs: 60_000, exitGraceMs: 5_000 },
          async (rpc) => {
            const started = (await rpc.request('thread/start', { cwd: project })) as {
              thread?: { cwd?: string }
            }
            return { threadCwd: started.thread?.cwd, running: processesIn(project) }
          },
          createSshAgentProcessSpawn(real.mux, {
            cwd: project,
            deadlineMs: 60_000,
            envOverlay: { CODEX_HOME: home }
          }) as never
        )
        expect(realpathSync(observed.threadCwd ?? '')).toBe(realpathSync(project))
        // The kernel's answer, not the echoed request: the installed binary runs in the project.
        expect(observed.running.some((exe) => /codex/.test(exe))).toBe(true)
        expect(await waitUntil(() => processesIn(project).length === 0, 10_000)).toBe(true)
      } finally {
        await real.handler.dispose()
        real.mux.dispose()
        rmSync(home, { recursive: true, force: true })
      }
    }, 90_000)
  }
)
