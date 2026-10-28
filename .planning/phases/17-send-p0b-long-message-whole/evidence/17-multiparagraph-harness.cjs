// SEND-P0b phase 17: does a long multi-paragraph phone body reach claude.exe (ConPTY) whole?
// Usage: node 17-multiparagraph-harness.cjs <repoRoot> <scenario> [paragraphs] [sep]
// Synthetic text only. Admission = the provider request; "whole" = head AND tail markers in ONE user message.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')
const repo = process.argv[2]
const scenario = process.argv[3]
const paragraphs = Number(process.argv[4] || 4)
const sep = (process.argv[5] || 'lf') === 'crlf' ? '\r\n' : '\n'
const pty = require(path.join(repo, 'node_modules/node-pty'))
const { Terminal } = require(path.join(repo, 'node_modules/@xterm/headless'))

const id = crypto.randomUUID().slice(0, 8)
const head = `HEADMARK-${id}`
const tail = `TAILMARK-${id}`
const para =
  'the phone asks the desktop agent a longer question about the drive and the community deposit, ' +
  'with enough words that every paragraph is well over a hundred characters long'
const parts = Array.from({ length: paragraphs }, (_, i) => `${i === 0 ? `${head} ` : ''}Paragraph ${i + 1}: ${para}${i === 1 ? ' 😂' : ''}.`)
parts[parts.length - 1] += ` ${tail}`
const body = parts.join(`${sep}${sep}`)
const requests = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function lastUserText(raw) {
  try {
    const msgs = JSON.parse(raw).messages || []
    const u = [...msgs].reverse().find((m) => m.role === 'user')
    if (!u) return null
    if (typeof u.content === 'string') return u.content
    return u.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  } catch { return null }
}

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  ev('message_start', { message: { id: 'msg_p17', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } })
  ev('content_block_stop', { index: 0 })
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
  ev('message_stop', {})
  res.end()
}

async function main() {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const isTurn = req.url.startsWith('/v1/messages') && !req.url.includes('count_tokens')
      if (isTurn && (raw.includes(head) || raw.includes(tail))) {
        const text = lastUserText(raw)
        requests.push({ hasHead: raw.includes(head), hasTail: raw.includes(tail), userText: text })
      }
      if (isTurn) {
        let stream = false
        try { stream = JSON.parse(raw).stream === true } catch { stream = false }
        if (stream) return sse(res)
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: 'msg_p17', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
      }
      if (req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ input_tokens: 1 }))
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sendp0b-p17-'))
  const cfg = path.join(root, 'cfg')
  const cwd = path.join(root, 'work')
  fs.mkdirSync(cfg); fs.mkdirSync(cwd)
  const key = 'sk-ant-api03-' + 'x'.repeat(80) + 'SENDP0BP17KEYAAAAAAAA'
  const projects = {}
  for (const p of [cwd, cwd.replace(/\\/g, '/')]) projects[p] = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] }
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', numStartups: 5, customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }, projects }))

  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' }
  for (const k of Object.keys(env)) if ((k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') && k !== 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC') delete env[k]
  const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  const p = pty.spawn('claude.exe', [], { name: 'xterm-256color', cols: 120, rows: 40, cwd, env, useConpty: true })
  let lastOut = Date.now()
  p.onData((d) => { term.write(d); lastOut = Date.now() })
  const screen = () => { const b = term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i)?.translateToString(true); if (l && l.trim()) out.push(l) } return out }
  const quiet = async (ms, cap) => { const t0 = Date.now(); while (Date.now() - lastOut < ms && Date.now() - t0 < cap) await sleep(100) }

  const t00 = Date.now()
  while (!screen().some((l) => l.startsWith('❯')) && Date.now() - t00 < 45000) await sleep(200)
  await quiet(2000, 15000)
  if (!screen().some((l) => l.startsWith('❯'))) { console.log(JSON.stringify({ scenario, error: 'prompt never rendered', tail: screen().slice(-10) })); process.exit(2) }

  // Shipped phone shape (854f34c01): clear as its own write, raw body, host Enter 500 ms later.
  if (scenario === 'mobile-split') { p.write('\x15'); await sleep(50); p.write(body); await sleep(500); p.write('\r') }
  // Host settled agent-prompt shape: clear, bracketed paste, Windows settle, Enter.
  else if (scenario === 'paste') { p.write('\x15'); await sleep(50); p.write(`\x1b[200~${body}\x1b[201~`); await sleep(1500); await quiet(500, 10000); p.write('\r') }
  else throw new Error('scenario?')
  await sleep(10000)
  const after = screen()
  const whole = requests.some((r) => r.hasHead && r.hasTail)
  console.log(JSON.stringify({
    scenario, paragraphs, sep: sep === '\n' ? 'lf' : 'crlf', bodyLength: body.length, whole,
    turns: requests.length,
    requests: requests.map((r) => ({ hasHead: r.hasHead, hasTail: r.hasTail, userTextLength: r.userText?.length ?? null, userTextStart: r.userText?.slice(0, 80) ?? null })),
    afterTail: after.slice(-8)
  }, null, 1))
  p.kill(); server.close()
  setTimeout(() => process.exit(0), 500)
}
main().catch((e) => { console.error(e); process.exit(1) })
