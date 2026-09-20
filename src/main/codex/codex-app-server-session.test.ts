import { afterEach, describe, expect, it } from 'vitest'
import { runCodexAppServerSession } from './codex-app-server-session'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
})

describe('runCodexAppServerSession environment', () => {
  it('removes inherited variables requested by a default-home invocation', async () => {
    process.env.CODEX_HOME = '/tmp/inherited-managed-home'
    const server = String.raw`
      const readline = require('node:readline')
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line)
        if (typeof message.id !== 'number') return
        const result = message.method === 'env/get'
          ? { codexHome: process.env.CODEX_HOME ?? null }
          : {}
        process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n')
      })
    `

    const result = await runCodexAppServerSession(
      {
        command: process.execPath,
        args: ['-e', server],
        envToDelete: ['CODEX_HOME'],
        timeoutMs: 5_000
      },
      ({ request }) => request('env/get')
    )

    expect(result).toEqual({ codexHome: null })
  })
})

// W0 measured this against the real installed binary: `account/read` sent with no `params` key
// came back -32600 Invalid Request. JSON-RPC 2.0 permits omitting params; this server does not.
// The fake below reproduces exactly that rule and nothing else.
const PARAMS_REQUIRED_SERVER = String.raw`
  const readline = require('node:readline')
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (typeof message.id !== 'number') return
    const response = Object.hasOwn(message, 'params')
      ? { id: message.id, result: { sawParams: message.params } }
      : { id: message.id, error: { code: -32600, message: 'Invalid Request' } }
    process.stdout.write(JSON.stringify(response) + '\n')
  })
`

describe('runCodexAppServerSession wire shape', () => {
  it('always sends a params member, even when the caller supplies none', async () => {
    const result = await runCodexAppServerSession(
      { command: process.execPath, args: ['-e', PARAMS_REQUIRED_SERVER], timeoutMs: 5_000 },
      ({ request }) => request('account/read')
    )

    // An empty object, not an absent key. Dropping the member is what the server rejects.
    expect(result).toEqual({ sawParams: {} })
  })

  it('CONTROL: a caller-supplied params object is passed through unchanged', async () => {
    // Without this, a fix that hardcoded `params: {}` would pass the case above while silently
    // discarding every real argument.
    const result = await runCodexAppServerSession(
      { command: process.execPath, args: ['-e', PARAMS_REQUIRED_SERVER], timeoutMs: 5_000 },
      ({ request }) => request('thread/resume', { threadId: 'abc', cwd: '/tmp' })
    )

    expect(result).toEqual({ sawParams: { threadId: 'abc', cwd: '/tmp' } })
  })
})
