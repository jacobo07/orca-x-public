// SEND-P0 H1 harness: real claude.exe TUI under ConPTY, Orca's exact byte shapes, admission observed at a fake API.
// Usage: node trace.cjs <repoRoot> <scenario> [bodyChars]
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')
const repo = process.argv[2]
const scenario = process.argv[3]
const bodyChars = Number(process.argv[4] || 0)
const pty = require(path.join(repo, 'node_modules/node-pty'))
const { Terminal } = require(path.join(repo, 'node_modules/@xterm/headless'))

const nonce = `ORCA-NONCE-${crypto.randomUUID().slice(0, 8)}`
const padUnit = ' the phone asks the desktop agent a question'
const padding = bodyChars > 0 ? padUnit.repeat(Math.ceil(bodyChars / padUnit.length)).slice(0, bodyChars) : ''
const bodyFile = process.env.SENDP0_BODY_FILE
const body = bodyFile ? `${fs.readFileSync(bodyFile, 'utf8').trim()} ${nonce}` : `Reply with ok. ${nonce}${padding}`
const requests = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  ev('message_start', { message: { id: 'msg_h1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
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
      requests.push({ url: req.url, hasNonce: raw.includes(nonce) })
      if (req.url.startsWith('/v1/messages') && !req.url.includes('count_tokens')) {
        let stream = false
        try { stream = JSON.parse(raw).stream === true } catch { stream = false }
        if (stream) return sse(res)
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: 'msg_h1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sendp0-h1-'))
  const cfg = path.join(root, 'cfg')
  const cwd = path.join(root, 'work')
  fs.mkdirSync(cfg); fs.mkdirSync(cwd)
  const key = 'sk-ant-api03-' + 'x'.repeat(80) + 'SENDP0H1KEYAAAAAAAAAA'
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
  const ready = screen()
  if (!ready.some((l) => l.startsWith('❯'))) { console.log(JSON.stringify({ scenario, error: 'prompt never rendered', tail: ready.slice(-10) })); process.exit(2) }
  const t0 = Date.now()
  if (scenario === 'mobile') { p.write(`\x15${body}`); await sleep(500); p.write('\r') }
  else if (scenario === 'mobile-slow') { p.write(`\x15${body}`); await sleep(3000); p.write('\r') }
  else if (scenario === 'mobile-noclear') { p.write(body); await sleep(500); p.write('\r') }
  else if (scenario === 'desktop') { p.write(`\x1b[200~${body}\x1b[201~`); await sleep(1500); await quiet(500, 10000); p.write('\r') }
  else if (scenario === 'mobile-split') { p.write('\x15'); await sleep(50); p.write(body); await sleep(500); p.write('\r') }
  else if (scenario === 'mobile-dirty-split') { p.write('stale draft line'); await sleep(800); p.write('\x15'); await sleep(50); p.write(body); await sleep(500); p.write('\r') }
  else throw new Error('scenario?')
  const t1 = Date.now()
  await sleep(8000)
  const admitted = requests.some((r) => r.hasNonce)
  const after = screen()
  const linesWithNonce = after.filter((l) => l.includes(nonce.slice(0, 18)))
  console.log(JSON.stringify({ scenario, bodyLength: body.length, nonce, submitGapMs: t1 - t0, admitted, requestUrls: requests.map((r) => `${r.url}${r.hasNonce ? ' [NONCE]' : ''}`), linesWithNonce, readyTail: ready.slice(-6), afterTail: after.slice(-12) }, null, 1))
  p.kill(); server.close()
  setTimeout(() => process.exit(0), 500)
}
main().catch((e) => { console.error(e); process.exit(1) })
