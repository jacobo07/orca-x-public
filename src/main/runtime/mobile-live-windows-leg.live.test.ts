import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RuntimeTerminalRead } from '../../shared/runtime-types'
import { judgeFreshTerminalOutput } from '../../shared/terminal-fresh-output-oracle'
import {
  connectMobileProtocolClient,
  type MobileProtocolClient
} from '../../../tests/e2e/helpers/mobile-protocol-client'

// Plane: the Owner's installed, running Windows Orca X, paired from its own Mobile screen, driven by a
// scripted client speaking the phone protocol. SCRIPTED CLIENT evidence: not a phone, not an emulator.
// ORCA_LIVE_LEG=phone: create a dedicated terminal, prove send by fresh output, reconnect, then wait
// for the Owner to revoke this device and prove the next mutation is refused.
// ORCA_LIVE_LEG=witness: a second pairing proves the revoked send never reached the PTY, then closes it.

const LEG = process.env.ORCA_LIVE_LEG
const PAIRING = process.env.ORCA_LIVE_PAIRING ?? ''
const REPO_PATH = process.env.ORCA_LIVE_REPO_PATH ?? ''
const STATE_FILE = process.env.ORCA_LIVE_STATE ?? ''
const REVOKE_WAIT_MS = 5 * 60_000
const CALL_TIMEOUT_MS = 10_000

type LegState = {
  handle: string
  ptyId: string | null
  marker: string
  revokedNonce: string
  cursor: string
}

const NO_REPLY = Symbol('no reply')

async function call(phone: MobileProtocolClient, method: string, params: unknown) {
  const timeout = new Promise<typeof NO_REPLY>((resolve) =>
    setTimeout(() => resolve(NO_REPLY), CALL_TIMEOUT_MS)
  )
  return Promise.race([phone.call(method, params), timeout])
}

function ok<T>(response: Record<string, unknown> | typeof NO_REPLY, what: string): T {
  if (response === NO_REPLY || response.ok !== true) {
    throw new Error(
      `${what} failed: ${response === NO_REPLY ? 'no reply' : JSON.stringify(response.error)}`
    )
  }
  return response.result as T
}

function printing(marker: string, nonce: string): string {
  return `"${process.execPath}" -e "console.log('${marker}'+' '+'${nonce}')"`
}

async function read(phone: MobileProtocolClient, handle: string, cursor?: string) {
  const params = { terminal: handle, ...(cursor !== undefined ? { cursor: Number(cursor) } : {}) }
  return ok<{ terminal: RuntimeTerminalRead }>(await call(phone, 'terminal.read', params), 'read')
    .terminal
}

async function sendAndProve(phone: MobileProtocolClient, handle: string, marker: string) {
  const nonce = `nonce-${randomUUID().slice(0, 8)}`
  const sentText = printing(marker, nonce)
  const before = await read(phone, handle)
  ok(await call(phone, 'terminal.send', { terminal: handle, text: sentText, enter: true }), 'send')
  await expect
    .poll(
      async () =>
        judgeFreshTerminalOutput({
          handle,
          marker,
          nonce,
          sentText,
          before,
          after: await read(phone, handle, before.latestCursor)
        }).verdict,
      { timeout: 30_000, interval: 500 }
    )
    .toBe('FRESH')
}

async function listed(phone: MobileProtocolClient) {
  return ok<{ terminals: { handle: string; ptyId: string | null }[] }>(
    await call(phone, 'terminal.list', { worktree: `path:${REPO_PATH}` }),
    'list'
  ).terminals
}

describe.skipIf(LEG !== 'phone' || !PAIRING || !REPO_PATH || !STATE_FILE)(
  'live Windows leg: phone',
  () => {
    it(
      'drives a dedicated PTY on the Owner desktop, reconnects, and is refused after revoke',
      async () => {
        const marker = `ORCA-LIVE-${randomUUID().slice(0, 8)}`
        let phone = await connectMobileProtocolClient(PAIRING)
        const repos = ok<{ repos: { path: string }[] }>(
          await call(phone, 'repo.list', {}),
          'repo.list'
        ).repos
        console.log(`REPOS in Orca: ${JSON.stringify(repos.map((r) => r.path))}`)
        expect(
          repos.map((r) => r.path),
          'ORCA_LIVE_REPO_PATH must be a project already in Orca'
        ).toContain(REPO_PATH)
        const created = ok<{ terminal: { handle: string } }>(
          await call(phone, 'terminal.create', { worktree: `path:${REPO_PATH}` }),
          'create'
        )
        const handle = created.terminal.handle
        const before = await listed(phone)
        const target = before.find((t) => t.handle === handle)
        expect(target, 'the created terminal is listed on the desktop host').toBeTruthy()
        await sendAndProve(phone, handle, marker)

        await phone.close()
        phone = await connectMobileProtocolClient(PAIRING)
        const after = await listed(phone)
        expect(after.map((t) => [t.handle, t.ptyId])).toEqual(
          before.map((t) => [t.handle, t.ptyId])
        )
        await sendAndProve(phone, handle, marker)
        const foreign = await call(phone, 'terminal.send', {
          terminal: `term_${randomUUID()}`,
          text: 'x',
          enter: true
        })
        expect(
          foreign !== NO_REPLY && foreign.ok === false,
          'a handle this host never minted is refused'
        ).toBe(true)

        console.log(
          `\n>>> REVOKE NOW: Orca X > Mobile > revoke the newest device. Waiting up to 5 min.\n`
        )
        const revokedNonce = `nonce-${randomUUID().slice(0, 8)}`
        const cursor = (await read(phone, handle)).latestCursor
        writeFileSync(
          STATE_FILE,
          JSON.stringify({ handle, ptyId: target!.ptyId, marker, revokedNonce, cursor })
        )
        let refusal: unknown = null
        await expect
          .poll(
            async () => {
              const reply = await call(phone, 'terminal.read', { terminal: handle })
              refusal = reply === NO_REPLY ? 'NO_REPLY' : reply.ok === true ? null : reply.error
              return refusal !== null
            },
            { timeout: REVOKE_WAIT_MS, interval: 2_000 }
          )
          .toBe(true)
        const revokedSend = await call(phone, 'terminal.send', {
          terminal: handle,
          text: printing(marker, revokedNonce),
          enter: true
        })
        expect(
          revokedSend === NO_REPLY || revokedSend.ok === false,
          'revoked device mutation refused'
        ).toBe(true)
        console.log(`REVOKED read refusal: ${JSON.stringify(refusal)}`)
        console.log(
          `REVOKED send reply: ${revokedSend === NO_REPLY ? 'NO_REPLY' : JSON.stringify(revokedSend.error)}`
        )
        await phone.close()
        await expect(
          connectMobileProtocolClient(PAIRING),
          'a revoked token cannot re-authenticate'
        ).rejects.toThrow()
      },
      REVOKE_WAIT_MS + 120_000
    )
  }
)

describe.skipIf(
  LEG !== 'witness' || !PAIRING || !REPO_PATH || !STATE_FILE || !existsSync(STATE_FILE)
)('live Windows leg: witness', () => {
  it('sees the same PTY, never the revoked nonce, then closes the dedicated terminal', async () => {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as LegState
    const witness = await connectMobileProtocolClient(PAIRING)
    try {
      const target = (await listed(witness)).find((t) => t.handle === state.handle)
      expect(target?.ptyId, 'same PTY identity seen by a second client').toBe(state.ptyId)
      const afterRevoke = await read(witness, state.handle, state.cursor)
      // Why: the revoked send happened after state.cursor, so only output past it could prove delivery.
      const before = { ...afterRevoke, tail: [], latestCursor: state.cursor }
      const verdict = judgeFreshTerminalOutput({
        handle: state.handle,
        marker: state.marker,
        nonce: state.revokedNonce,
        sentText: printing(state.marker, state.revokedNonce),
        before,
        after: afterRevoke
      }).verdict
      expect(verdict, 'the revoked send never produced output').toBe('ABSENT')
      await sendAndProve(witness, state.handle, state.marker)
    } finally {
      ok(await call(witness, 'terminal.close', { terminal: state.handle }), 'close')
      await witness.close()
    }
  }, 120_000)
})
