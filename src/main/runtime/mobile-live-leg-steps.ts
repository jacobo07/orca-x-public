import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { RuntimeTerminalRead } from '../../shared/runtime-types'
import { judgeFreshTerminalOutput } from '../../shared/terminal-fresh-output-oracle'
import type { MobileProtocolClient } from './mobile-protocol-test-client'

// Steps shared by the live legs (*.live.test.ts): a scripted phone-protocol client against real hosts.

export const NO_REPLY = Symbol('no reply')
const CALL_TIMEOUT_MS = 10_000

export type LiveReply = Record<string, unknown> | typeof NO_REPLY

export async function call(phone: MobileProtocolClient, method: string, params: unknown) {
  const timeout = new Promise<typeof NO_REPLY>((resolve) =>
    setTimeout(() => resolve(NO_REPLY), CALL_TIMEOUT_MS)
  )
  return Promise.race([phone.call(method, params), timeout])
}

export function ok<T>(response: LiveReply, what: string): T {
  if (response === NO_REPLY || response.ok !== true) {
    throw new Error(
      `${what} failed: ${response === NO_REPLY ? 'no reply' : JSON.stringify(response.error)}`
    )
  }
  return response.result as T
}

export function refused(response: LiveReply): boolean {
  return response === NO_REPLY || response.ok === false
}

/** Runs a node one-liner the same way in cmd, PowerShell and POSIX shells. */
export function nodeCommand(script: string, node = 'node'): string {
  // Why: PowerShell treats a leading quoted path as a string, not a call, so the binary stays bare.
  if (/\s/.test(node)) {
    throw new Error(`node path must not contain whitespace: ${node}`)
  }
  return `${node} -e "${script}"`
}

/** A command whose execution, never its echo, prints `marker nonce`, then `HOST <hostname> <platform>`. */
export function printing(marker: string, nonce: string, node?: string): string {
  return nodeCommand(
    `console.log('${marker}'+' '+'${nonce}');console.log('HOST'+' '+require('os').hostname()+' '+process.platform)`,
    node
  )
}

export async function read(phone: MobileProtocolClient, handle: string, cursor?: string) {
  const params = { terminal: handle, ...(cursor !== undefined ? { cursor: Number(cursor) } : {}) }
  return ok<{ terminal: RuntimeTerminalRead }>(await call(phone, 'terminal.read', params), 'read')
    .terminal
}

/** Sends from the phone; resolves once the oracle sees fresh output, with the host line it printed. */
export async function sendAndProve(
  phone: MobileProtocolClient,
  handle: string,
  marker: string,
  node?: string
): Promise<{ nonce: string; host: string | null }> {
  const nonce = `nonce-${randomUUID().slice(0, 8)}`
  const sentText = printing(marker, nonce, node)
  const before = await read(phone, handle)
  ok(await call(phone, 'terminal.send', { terminal: handle, text: sentText, enter: true }), 'send')
  let after = before
  try {
    await expect
      .poll(
        async () => {
          after = await read(phone, handle, before.latestCursor)
          return judgeFreshTerminalOutput({ handle, marker, nonce, sentText, before, after })
            .verdict
        },
        { timeout: 30_000, interval: 500 }
      )
      .toBe('FRESH')
  } catch (error) {
    const tail = (await read(phone, handle)).tail.slice(-12)
    throw new Error(`no fresh output on ${handle}; terminal tail: ${JSON.stringify(tail)}`, {
      cause: error
    })
  }
  const host = after.tail.map((line) => line.trim()).find((line) => /^HOST \S+ \S+$/.test(line))
  return { nonce, host: host ?? null }
}

/** True when no line `marker nonce` appeared after `cursor`; the read itself must not be truncated. */
export async function absentSince(
  phone: MobileProtocolClient,
  handle: string,
  cursor: string | undefined,
  marker: string,
  nonce: string
): Promise<boolean> {
  const after = await read(phone, handle, cursor)
  expect(after.truncated, 'a truncated read cannot prove absence').toBeFalsy()
  return !after.tail.some((line) => line.trim() === `${marker} ${nonce}`)
}

/** The host's own spelling of a registered project path; separators and drive case vary by host. */
export async function registeredRepoPath(phone: MobileProtocolClient, wanted: string) {
  const canonical = (path: string) =>
    path.replaceAll('\\', '/').replace(/^[a-z]:/, (d) => d.toUpperCase())
  const repos = ok<{ repos: { path: string }[] }>(
    await call(phone, 'repo.list', {}),
    'repo.list'
  ).repos
  const match = repos.find((repo) => canonical(repo.path) === canonical(wanted))
  if (!match) {
    throw new Error(
      `${wanted} is not registered; host lists ${JSON.stringify(repos.map((r) => r.path))}`
    )
  }
  return match.path
}

export async function listed(phone: MobileProtocolClient, repoPath: string) {
  return ok<{ terminals: { handle: string; ptyId: string | null }[] }>(
    await call(phone, 'terminal.list', { worktree: `path:${repoPath}` }),
    'list'
  ).terminals
}
