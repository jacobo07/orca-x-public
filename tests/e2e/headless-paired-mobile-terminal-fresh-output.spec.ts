import { randomUUID } from 'node:crypto'
import type { RuntimeTerminalRead } from '../../src/shared/runtime-types'
import {
  judgeFreshTerminalOutput,
  type FreshTerminalOutputJudgement
} from '../../src/shared/terminal-fresh-output-oracle'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  connectMobileProtocolClient,
  type MobileProtocolClient
} from './helpers/mobile-protocol-client'

// Plane: the built app in --serve mode with an isolated profile and a real PTY, driven by a scripted
// client speaking the phone's protocol. Not a phone, not an emulator, not the Owner's desktop app.

const MARKER = `ORCA-PHONE-MARKER-${randomUUID().slice(0, 8)}`

// Why: the expected line `MARKER NONCE` must not appear in the typed text, or its echo would pass.
function commandPrinting(nonce: string): string {
  if (process.platform === 'win32') {
    return `"${process.execPath}" -e "console.log('${MARKER}'+' '+'${nonce}')"`
  }
  return `echo ${MARKER}' '${nonce}`
}

function ok<T>(response: Record<string, unknown>, what: string): T {
  if (response.ok !== true) {
    throw new Error(`${what} failed: ${JSON.stringify(response.error)}`)
  }
  return response.result as T
}

async function read(phone: MobileProtocolClient, handle: string, cursor?: string) {
  const result = ok<{ terminal: RuntimeTerminalRead }>(
    await phone.call('terminal.read', {
      terminal: handle,
      ...(cursor !== undefined ? { cursor: Number(cursor) } : {})
    }),
    'terminal.read'
  )
  return result.terminal
}

/** Sends from the phone and polls until the oracle judges the output FRESH or time runs out. */
async function sendAndProve(phone: MobileProtocolClient, handle: string, nonce: string) {
  const sentText = commandPrinting(nonce)
  const before = await read(phone, handle)
  ok(await phone.call('terminal.send', { terminal: handle, text: sentText, enter: true }), 'send')
  let last: FreshTerminalOutputJudgement = { verdict: 'UNKNOWN', reason: 'not read yet' }
  await expect
    .poll(
      async () => {
        const after = await read(phone, handle, before.latestCursor)
        last = judgeFreshTerminalOutput({ handle, marker: MARKER, nonce, sentText, before, after })
        return last.verdict
      },
      { timeout: 30_000, message: `fresh-output oracle never saw ${nonce}` }
    )
    .toBe('FRESH')
  return last
}

test('a paired phone drives a real PTY, proven by fresh output, across a reconnect', async ({
  testRepoPath
}) => {
  test.setTimeout(180_000)
  const host = await launchHeadlessPairedRuntimeHost()
  let phone: MobileProtocolClient | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const created = await host.client.call<{ terminal: { handle: string } }>('terminal.create', {
      worktree: `path:${testRepoPath}`
    })
    const handle = created.result.terminal.handle

    phone = await connectMobileProtocolClient(host.offer.pairingUrl)
    const listedBefore = ok<{ terminals: { handle: string; ptyId: string | null }[] }>(
      await phone.call('terminal.list', { worktree: `path:${testRepoPath}` }),
      'terminal.list'
    ).terminals
    const target = listedBefore.find((terminal) => terminal.handle === handle)
    expect(target, 'the phone sees the terminal the laptop created').toBeTruthy()

    const sentNonce = `nonce-${randomUUID().slice(0, 8)}`
    expect(await sendAndProve(phone, handle, sentNonce)).toEqual({ verdict: 'FRESH' })

    // Control on this plane: a nonce that was never sent is ABSENT over the same live output.
    const neverSent = `nonce-${randomUUID().slice(0, 8)}`
    const controlBefore = await read(phone, handle)
    await phone.call('terminal.send', {
      terminal: handle,
      text: commandPrinting(sentNonce).replace(sentNonce, 'other'),
      enter: true
    })
    await expect
      .poll(async () => (await read(phone!, handle, controlBefore.latestCursor)).tail.join('\n'))
      .toContain(`${MARKER} other`)
    expect(
      judgeFreshTerminalOutput({
        handle,
        marker: MARKER,
        nonce: neverSent,
        sentText: commandPrinting(neverSent),
        before: controlBefore,
        after: await read(phone, handle, controlBefore.latestCursor)
      }).verdict
    ).toBe('ABSENT')

    // Reconnect: same device token on a new socket; identity and PTY are unchanged.
    await phone.close()
    phone = await connectMobileProtocolClient(host.offer.pairingUrl)
    const listedAfter = ok<{ terminals: { handle: string; ptyId: string | null }[] }>(
      await phone.call('terminal.list', { worktree: `path:${testRepoPath}` }),
      'terminal.list'
    ).terminals
    expect(listedAfter.map((t) => [t.handle, t.ptyId])).toEqual(
      listedBefore.map((t) => [t.handle, t.ptyId])
    )
    expect(await sendAndProve(phone, handle, `nonce-${randomUUID().slice(0, 8)}`)).toEqual({
      verdict: 'FRESH'
    })

    // A handle this host never minted is refused and touches no PTY.
    const foreign = await phone.call('terminal.send', {
      terminal: `term_${randomUUID()}`,
      text: commandPrinting('foreign'),
      enter: true
    })
    expect(foreign.ok).toBe(false)
  } finally {
    await phone?.close()
    await host.dispose()
  }
})
