import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  connectMobileProtocolClient,
  type MobileProtocolClient
} from './mobile-protocol-test-client'
import {
  absentSince,
  call,
  listed,
  nodeCommand,
  ok,
  read,
  refused,
  registeredRepoPath,
  sendAndProve
} from './mobile-live-leg-steps'

// Plane: one scripted phone-protocol client paired to two real hosts at once. Host A is a Windows
// machine (an Orca X host on win32); host B is the built app in --serve mode on GEX44, reachable only
// through an ssh -L tunnel to its loopback listener, which this test owns so it can cut the transport.
// SCRIPTED CLIENT evidence: not a phone, not an emulator.

const A_PAIRING = process.env.ORCA_LIVE_A_PAIRING ?? ''
const A_REPO = process.env.ORCA_LIVE_A_REPO_PATH ?? ''
const B_PAIRING = process.env.ORCA_LIVE_B_PAIRING ?? ''
const B_REPO = process.env.ORCA_LIVE_B_REPO_PATH ?? ''
const B_NODE = process.env.ORCA_LIVE_B_NODE ?? ''
const B_SSH_HOST = process.env.ORCA_LIVE_B_SSH_HOST ?? ''
const B_PORT = Number(process.env.ORCA_LIVE_B_PORT ?? '0')
const READY = Boolean(A_PAIRING && A_REPO && B_PAIRING && B_REPO && B_NODE && B_SSH_HOST && B_PORT)
const OUTAGE_MS = 15_000

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

async function openTunnel(): Promise<ChildProcess> {
  const forward = `127.0.0.1:${B_PORT}:127.0.0.1:${B_PORT}`
  const tunnel = spawn(
    'ssh',
    ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-L', forward, B_SSH_HOST],
    {
      stdio: 'ignore'
    }
  )
  await expect.poll(() => portOpen(B_PORT), { timeout: 20_000, interval: 250 }).toBe(true)
  return tunnel
}

async function closeTunnel(tunnel: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => tunnel.once('exit', resolve))
  tunnel.kill()
  await exited
  await expect.poll(() => portOpen(B_PORT), { timeout: 10_000, interval: 250 }).toBe(false)
}

async function createTerminal(phone: MobileProtocolClient, repo: string): Promise<string> {
  return ok<{ terminal: { handle: string } }>(
    await call(phone, 'terminal.create', { worktree: `path:${repo}` }),
    'create'
  ).terminal.handle
}

describe.skipIf(!READY)('live two-host leg: one controller, Windows and GEX44', () => {
  it('scopes every send to the selected host and runtime, and survives a carrier cut on one host', async () => {
    const marker = `ORCA-2H-${randomUUID().slice(0, 8)}`
    let tunnel = await openTunnel()
    const hostA = await connectMobileProtocolClient(A_PAIRING)
    let hostB = await connectMobileProtocolClient(B_PAIRING)
    const created: { phone: () => MobileProtocolClient; handle: string }[] = []
    try {
      const aRepo = await registeredRepoPath(hostA, A_REPO)
      const bRepo = await registeredRepoPath(hostB, B_REPO)
      const termA = await createTerminal(hostA, aRepo)
      created.push({ phone: () => hostA, handle: termA })
      const termB = await createTerminal(hostB, bRepo)
      created.push({ phone: () => hostB, handle: termB })
      const tickB = await createTerminal(hostB, bRepo)
      created.push({ phone: () => hostB, handle: tickB })

      // Selected host A: executes on Windows, nothing reaches host B.
      const cursorB = (await read(hostB, termB)).latestCursor
      const onA = await sendAndProve(hostA, termA, marker)
      expect(onA.host, 'host A executed it').toMatch(/^HOST \S+ win32$/)
      expect(
        await absentSince(hostB, termB, cursorB, marker, onA.nonce),
        'host B never saw A'
      ).toBe(true)

      // Switch to host B: executes on GEX44, nothing reaches host A.
      const cursorA = (await read(hostA, termA)).latestCursor
      const onB = await sendAndProve(hostB, termB, marker, B_NODE)
      expect(onB.host, 'host B executed it').toMatch(/^HOST \S+ linux$/)
      expect(
        await absentSince(hostA, termA, cursorA, marker, onB.nonce),
        'host A never saw B'
      ).toBe(true)

      // A runtime id is host-scoped: each host refuses the other's handle.
      expect(
        refused(await call(hostB, 'terminal.send', { terminal: termA, text: 'x', enter: true })),
        'B refuses A handle'
      ).toBe(true)
      expect(
        refused(await call(hostA, 'terminal.send', { terminal: termB, text: 'x', enter: true })),
        'A refuses B handle'
      ).toBe(true)

      // Back to host A: same runtime identity, still live.
      const listedA = await listed(hostA, aRepo)
      expect(listedA.some((t) => t.handle === termA)).toBe(true)
      await sendAndProve(hostA, termA, marker)

      // Carrier cut on host B: a ticker keeps running there while host A keeps working.
      const tickCommand = nodeCommand(
        `let i=0;setInterval(()=>console.log('TICK'+' '+(i++)),1000)`,
        B_NODE
      )
      ok(
        await call(hostB, 'terminal.send', { terminal: tickB, text: tickCommand, enter: true }),
        'ticker'
      )
      const ptyBefore = (await listed(hostB, bRepo)).map((t) => [t.handle, t.ptyId])
      await expect
        .poll(
          async () => (await read(hostB, tickB)).tail.some((l) => /^TICK \d+$/.test(l.trim())),
          { timeout: 15_000 }
        )
        .toBe(true)
      const lastTick = async () =>
        Math.max(
          ...(await read(hostB, tickB)).tail
            .map((l) => /^TICK (\d+)$/.exec(l.trim())?.[1])
            .filter(Boolean)
            .map(Number)
        )
      const tickBeforeCut = await lastTick()

      await closeTunnel(tunnel)
      const cutAt = Date.now()
      expect(
        refused(await call(hostB, 'terminal.read', { terminal: termB })),
        'B unreachable during the cut'
      ).toBe(true)
      await sendAndProve(hostA, termA, marker)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, OUTAGE_MS - (Date.now() - cutAt)))
      )

      tunnel = await openTunnel()
      hostB = await connectMobileProtocolClient(B_PAIRING)
      expect(
        (await listed(hostB, bRepo)).map((t) => [t.handle, t.ptyId]),
        'no PTY added or replaced'
      ).toEqual(ptyBefore)
      const tickAfter = await lastTick()
      console.log(
        `TICKS before cut ${tickBeforeCut}, after reconnect ${tickAfter}, outage ${OUTAGE_MS} ms`
      )
      expect(
        tickAfter - tickBeforeCut,
        'the remote process kept running through the cut'
      ).toBeGreaterThanOrEqual(OUTAGE_MS / 1000 - 2)
      ok(await call(hostB, 'terminal.send', { terminal: tickB, text: '\u0003' }), 'stop ticker')
      await sendAndProve(hostB, termB, marker, B_NODE)
    } finally {
      for (const { phone, handle } of created) {
        await call(phone(), 'terminal.close', { terminal: handle })
      }
      await hostA.close()
      await hostB.close()
      tunnel.kill()
    }
  }, 240_000)
})
