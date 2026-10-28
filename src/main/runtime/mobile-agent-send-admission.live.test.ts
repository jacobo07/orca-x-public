import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { connectMobileProtocolClient } from './mobile-protocol-test-client'
import { call, listed, ok, read, registeredRepoPath } from './mobile-live-leg-steps'

// SEND-P0 phase 13 nonce trace through a real Orca host: a scripted phone (SCRIPTED CLIENT evidence) sends the
// native-chat bytes into a Claude Code TUI running in an Orca PTY. The host's Claude points ANTHROPIC_BASE_URL at
// the fake API below, so "the agent turn exists" is observed as a provider request carrying the nonce, with no
// quota spent. Shape A is what the phone sends today; shape B (clear as its own write) is the control.

const PAIRING = process.env.ORCA_LIVE_PAIRING ?? ''
const REPO_PATH = process.env.ORCA_LIVE_REPO_PATH ?? ''
const FAKE_API_PORT = Number(process.env.ORCA_LIVE_FAKE_API_PORT ?? 0)
// Same shape as the Owner's failed message (Spanish, two emoji, ~140 chars), not its text.
const OWNER_MESSAGE =
  'podrías revisar si el despliegue de mañana sigue en pie? 😂😂 porque he visto que soporte cambió la ventana y nadie avisó al cliente'
const ADMISSION_WAIT_MS = 12_000

function startFakeProviderApi(port: number): Promise<{ server: Server; bodies: string[] }> {
  const bodies: string[] = []
  const event = (type: string, data: object): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      bodies.push(raw)
      if (req.url?.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        event('message_start', {
          message: {
            id: 'msg_trace',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 }
          }
        }) +
          event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
          event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
          event('content_block_stop', { index: 0 }) +
          event('message_delta', {
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 }
          }) +
          event('message_stop', {})
      )
    })
  })
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ server, bodies }))
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!PAIRING || !REPO_PATH || !FAKE_API_PORT)(
  'live nonce trace: mobile Agent send',
  () => {
    it('a phone chat message into Claude Code becomes an agent turn', async () => {
      const api = await startFakeProviderApi(FAKE_API_PORT)
      const phone = await connectMobileProtocolClient(PAIRING)
      const client = { id: `sendp0-trace-${randomUUID().slice(0, 8)}`, type: 'mobile' as const }
      let handle = ''
      try {
        const repo = await registeredRepoPath(phone, REPO_PATH)
        handle = ok<{ terminal: { handle: string } }>(
          await call(phone, 'terminal.create', { worktree: `path:${repo}` }),
          'create'
        ).terminal.handle
        await sleep(4_000)
        ok(
          await call(phone, 'terminal.send', { terminal: handle, text: 'claude', enter: true }),
          'launch'
        )
        await expect
          .poll(async () => (await read(phone, handle)).tail.some((l) => l.startsWith('❯')), {
            timeout: 60_000,
            interval: 1_000
          })
          .toBe(true)
        // Why: input sent within ~2 s of the first prompt render was measured to drop Enter even for the
        // admitted shape, which would make the control fail for a reason unrelated to the send shape.
        await sleep(2_500)
        ok(
          await call(phone, 'terminal.subscribe', {
            terminal: handle,
            client,
            capabilities: { terminalBinaryStream: 1 }
          }),
          'subscribe'
        )
        await sleep(1_500)

        const trace = async (shape: 'A-bundled' | 'B-split') => {
          const nonce = `ORCA-NONCE-${randomUUID().slice(0, 8)}`
          const body = `${OWNER_MESSAGE} ${nonce}`
          const replies: unknown[] = []
          if (shape === 'B-split') {
            replies.push(
              await call(phone, 'terminal.send', {
                terminal: handle,
                text: '\x15',
                enter: false,
                client
              })
            )
          }
          const text = shape === 'A-bundled' ? `\x15${body}` : body
          replies.push(
            await call(phone, 'terminal.send', { terminal: handle, text, enter: true, client })
          )
          await sleep(ADMISSION_WAIT_MS)
          const after = await read(phone, handle)
          const evidence = {
            shape,
            nonce,
            rpcReplies: replies,
            ptyId: (await listed(phone, repo)).find((t) => t.handle === handle)?.ptyId ?? null,
            linesWithNonce: after.tail.filter((l) => l.includes(nonce.slice(0, 15))),
            providerRequestsWithNonce: api.bodies.filter((b) => b.includes(nonce)).length,
            tail: after.tail.slice(-8)
          }
          console.log(`TRACE ${JSON.stringify(evidence)}`)
          // Leaves the input line empty for the next shape, as its own write.
          await call(phone, 'terminal.send', {
            terminal: handle,
            text: '\x15',
            enter: false,
            client
          })
          await sleep(1_000)
          return evidence
        }

        // B-split is what the phone writes since SEND-P0 phase 14 (pinned by
        // mobile/src/session/mobile-native-chat-send-admission.test.ts). A-bundled, the pre-fix shape, is
        // traced for the record only: Claude Code's paste detection is not ours to pin.
        const phoneShape = await trace('B-split')
        await trace('A-bundled')
        expect(phoneShape.providerRequestsWithNonce, 'the agent turn exists').toBeGreaterThan(0)
      } finally {
        if (handle) {
          await call(phone, 'terminal.close', { terminal: handle })
        }
        await phone.close()
        api.server.close()
      }
    }, 180_000)
  }
)
