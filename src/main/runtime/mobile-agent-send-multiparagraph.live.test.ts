import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { connectMobileProtocolClient } from './mobile-protocol-test-client'
import { call, listed, ok, read, registeredRepoPath } from './mobile-live-leg-steps'

// SEND-P0b phase 17: a long multi-paragraph phone chat body through a real Orca host into Claude Code.
// "Whole" = one provider request carries both the head and the tail marker. Synthetic text only.
// Same env and recipe as mobile-agent-send-admission.live.test.ts (13-serve-host.ps1).

const PAIRING = process.env.ORCA_LIVE_PAIRING ?? ''
const REPO_PATH = process.env.ORCA_LIVE_REPO_PATH ?? ''
const FAKE_API_PORT = Number(process.env.ORCA_LIVE_FAKE_API_PORT ?? 0)
const ADMISSION_WAIT_MS = 12_000
const PARAGRAPH =
  'the phone asks the desktop agent a longer question about the drive and the community deposit, ' +
  'with enough words that every paragraph is well over a hundred characters long'

function syntheticBody(head: string, tail: string, paragraphs: number): string {
  const parts = Array.from(
    { length: paragraphs },
    (_, i) => `${i === 0 ? `${head} ` : ''}Paragraph ${i + 1}: ${PARAGRAPH}${i === 1 ? ' 😂' : ''}.`
  )
  parts[parts.length - 1] += ` ${tail}`
  return parts.join('\n\n')
}

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
            id: 'msg_p17',
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
  'live: multi-paragraph mobile Agent send',
  () => {
    it('a long multi-paragraph phone message reaches Claude Code whole', async () => {
      const api = await startFakeProviderApi(FAKE_API_PORT)
      const phone = await connectMobileProtocolClient(PAIRING)
      const client = { id: `sendp0b-p17-${randomUUID().slice(0, 8)}`, type: 'mobile' as const }
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

        const trace = async (shape: 'split-raw' | 'split-paste', paragraphs: number) => {
          const id = randomUUID().slice(0, 8)
          const head = `HEADMARK-${id}`
          const tail = `TAILMARK-${id}`
          const body = syntheticBody(head, tail, paragraphs)
          const replies: unknown[] = []
          replies.push(
            await call(phone, 'terminal.send', {
              terminal: handle,
              text: '\x15',
              enter: false,
              client
            })
          )
          if (shape === 'split-raw') {
            replies.push(
              await call(phone, 'terminal.send', {
                terminal: handle,
                text: body,
                enter: true,
                client
              })
            )
          } else {
            replies.push(
              await call(phone, 'terminal.send', {
                terminal: handle,
                text: `\x1b[200~${body}\x1b[201~`,
                enter: false,
                client
              })
            )
            await sleep(1_500)
            replies.push(
              await call(phone, 'terminal.send', {
                terminal: handle,
                text: '\r',
                enter: false,
                client
              })
            )
          }
          await sleep(ADMISSION_WAIT_MS)
          const after = await read(phone, handle)
          const turns = api.bodies.filter((b) => b.includes(head) || b.includes(tail))
          const evidence = {
            shape,
            paragraphs,
            bodyLength: body.length,
            rpcReplies: replies,
            ptyId: (await listed(phone, repo)).find((t) => t.handle === handle)?.ptyId ?? null,
            requests: turns.map((b) => ({ head: b.includes(head), tail: b.includes(tail) })),
            whole: turns.some((b) => b.includes(head) && b.includes(tail)),
            tail: after.tail.slice(-8)
          }
          console.log(`TRACE ${JSON.stringify(evidence)}`)
          await call(phone, 'terminal.send', {
            terminal: handle,
            text: '\x15',
            enter: false,
            client
          })
          await sleep(1_000)
          return evidence
        }

        const raw4 = await trace('split-raw', 4)
        const raw6 = await trace('split-raw', 6)
        const paste6 = await trace('split-paste', 6)
        expect({ raw4: raw4.whole, raw6: raw6.whole, paste6: paste6.whole }).toBeDefined()
      } finally {
        if (handle) {
          await call(phone, 'terminal.close', { terminal: handle })
        }
        await phone.close()
        api.server.close()
      }
    }, 240_000)
  }
)
