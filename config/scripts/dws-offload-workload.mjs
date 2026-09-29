#!/usr/bin/env node
/**
 * DWS-P2 workload wrapper (CTX-MEAS-1/CTX-CLI-2). One identity-tagged, shell-agnostic entry point
 * for the three legs this phase measures: `test` (scoped vitest), `build` (CLI typecheck), `agent`
 * (a one-turn agent reply). Designed to be the `--command` of an `orca terminal create` (local or
 * remote), so its own stdout IS the terminal's scrollback the CLI/sampler observes.
 *
 * Shell-agnostic by construction: invoked as `node config/scripts/dws-offload-workload.mjs <leg>
 * --nonce <n> [...]`. No shell syntax (quoting, redirection, `&&`) is needed around it on
 * PowerShell, cmd or bash — every leg is spawned directly from this process, not via a shell string.
 *
 * `agentReply` is decided by the reply MARKER text, never by the child's exit code — "a settled
 * turn is not an answered turn" (memory: trap-a-settled-turn-is-not-an-answered-turn.md). A CLI can
 * exit 0 after printing a usage-limit message instead of ever answering the prompt.
 * Outcomes: matched | not-logged-in | usage-limit | spawn-failed | missing.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const USAGE_LIMIT_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /usageLimitExceeded/i,
  /weekly limit/i,
  /quota/i,
  /try again (later|in)/i
]

const NOT_LOGGED_IN_PATTERNS = [/not logged in/i, /please run \/login/i]

function nowIso() {
  return new Date().toISOString()
}

function parseArgs(argv) {
  const [leg, ...rest] = argv
  const opts = { leg, nonce: null, agentKind: 'claude', agentBin: null }
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '--nonce') {
      opts.nonce = rest[i + 1]
      i += 1
    } else if (arg === '--agent-kind') {
      opts.agentKind = rest[i + 1]
      i += 1
    } else if (arg === '--agent-bin') {
      opts.agentBin = rest[i + 1]
      i += 1
    }
  }
  return opts
}

/** Resolves a bare agent binary name to an absolute path via `where.exe` on win32; passes through
 * an explicit --agent-bin or a non-win32 bare name unchanged (POSIX spawn searches PATH itself). */
function resolveAgentBinary(agentKind, agentBin) {
  if (agentBin) {
    return { path: agentBin, resolvedVia: 'explicit --agent-bin' }
  }
  const bareName = agentKind === 'codex' ? 'codex' : 'claude'
  if (process.platform !== 'win32') {
    return { path: bareName, resolvedVia: 'PATH (POSIX spawn)' }
  }
  const result = spawnSync('where.exe', [bareName], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout) {
    return { path: null, resolvedVia: 'where.exe', notFound: true }
  }
  const firstLine = result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0)
  return { path: firstLine ? firstLine.trim() : null, resolvedVia: 'where.exe' }
}

/**
 * The agent must ANSWER, not repeat: the expected reply is derived from the nonce (its characters
 * reversed), so it never appears verbatim in the prompt. A CLI that echoes its input -- a header line,
 * a verbose/debug dump, a usage error quoting the prompt -- therefore cannot read as a matched reply.
 */
export function expectedAgentAnswer(nonce) {
  return `DWS-P2-AGENT-OK-${[...nonce].reverse().join('')}`
}

export function buildAgentPrompt(nonce) {
  // The prefix is followed by a space and prose, never by the reversed nonce, so the expected answer
  // is not a substring of this prompt even for a palindromic nonce.
  return `Reply with exactly the text DWS-P2-AGENT-OK- immediately followed by the characters of ${nonce} in reverse order (last character first), and nothing else.`
}

export function classifyAgentReply(capturedOutput, nonce) {
  // Scrubbing the prompt is belt and braces on top of the derivation above.
  const scrubbed = capturedOutput.split(buildAgentPrompt(nonce)).join('')
  if (scrubbed.includes(expectedAgentAnswer(nonce))) {
    return 'matched'
  }
  if (NOT_LOGGED_IN_PATTERNS.some((pattern) => pattern.test(capturedOutput))) {
    return 'not-logged-in'
  }
  if (USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(capturedOutput))) {
    return 'usage-limit'
  }
  return 'missing'
}

/** A child that never started prints nothing, so it must not read as a CLI that ran and failed. */
export function agentReplyFor({ captured, nonce, spawnError }) {
  return spawnError ? 'spawn-failed' : classifyAgentReply(captured, nonce)
}

function buildChildSpec(opts) {
  const execPath = process.execPath
  if (opts.leg === 'test') {
    return {
      command: execPath,
      args: [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'config/vitest.config.ts',
        'config/scripts/check-dws-completeness.test.mjs',
        'src/main/runtime/runtime-rpc-websocket-bind-host.test.ts'
      ]
    }
  }
  if (opts.leg === 'build') {
    return {
      command: execPath,
      args: [
        'node_modules/typescript/bin/tsc',
        '--noEmit',
        '-p',
        'config/tsconfig.cli.json',
        '--composite',
        'false'
      ]
    }
  }
  if (opts.leg === 'agent') {
    const resolved = resolveAgentBinary(opts.agentKind, opts.agentBin)
    if (resolved.notFound) {
      return { notFound: true, resolvedVia: resolved.resolvedVia }
    }
    const prompt = buildAgentPrompt(opts.nonce)
    const args = opts.agentKind === 'codex' ? ['exec', prompt] : ['-p', prompt]
    return { command: resolved.path, args, resolvedVia: resolved.resolvedVia }
  }
  return null
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (!existsSync(path.join(process.cwd(), 'package.json'))) {
    process.stderr.write(
      `dws-offload-workload: refusing to run — cwd (${process.cwd()}) has no package.json\n`
    )
    process.exit(2)
  }

  if (!opts.leg || !['test', 'build', 'agent'].includes(opts.leg)) {
    process.stderr.write(`dws-offload-workload: unknown leg "${opts.leg}". Expected test|build|agent.\n`)
    process.exit(2)
  }
  if (!opts.nonce) {
    process.stderr.write('dws-offload-workload: --nonce is required\n')
    process.exit(2)
  }

  const spec = buildChildSpec(opts)
  if (!spec) {
    process.stderr.write(`dws-offload-workload: could not build a child spec for leg "${opts.leg}"\n`)
    process.exit(2)
  }
  if (spec.notFound) {
    process.stdout.write(
      `DWS-P2-LEG-START nonce=${opts.nonce} leg=${opts.leg} childPid=none utc=${nowIso()}\n`
    )
    process.stdout.write(
      `DWS-P2-LEG-END nonce=${opts.nonce} leg=${opts.leg} exit=127 ms=0 utc=${nowIso()} agentReply=spawn-failed resolvedVia=${spec.resolvedVia}\n`
    )
    process.exit(127)
  }

  const startedAt = Date.now()
  const child = spawn(spec.command, spec.args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  })

  process.stdout.write(
    `DWS-P2-LEG-START nonce=${opts.nonce} leg=${opts.leg} childPid=${child.pid} utc=${nowIso()}\n`
  )

  let spawnError = null
  let captured = ''
  const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
  const forward = (chunk, sink) => {
    sink.write(chunk)
    if (captured.length < MAX_CAPTURE_BYTES) {
      captured += chunk.toString()
    }
  }
  child.stdout.on('data', (chunk) => forward(chunk, process.stdout))
  child.stderr.on('data', (chunk) => forward(chunk, process.stderr))

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 1)))
    child.on('error', (error) => {
      spawnError = error
      process.stderr.write(`dws-offload-workload: child failed to start: ${String(error)}\n`)
      resolve(1)
    })
  })

  const ms = Date.now() - startedAt
  const suffix =
    opts.leg === 'agent'
      ? ` agentReply=${agentReplyFor({ captured, nonce: opts.nonce, spawnError })}`
      : ''
  process.stdout.write(
    `DWS-P2-LEG-END nonce=${opts.nonce} leg=${opts.leg} exit=${exitCode} ms=${ms} utc=${nowIso()}${suffix}\n`
  )
  process.exit(exitCode)
}

// Why guarded on the test runner, not on "am I the entry script": a path comparison fails closed the
// wrong way (a symlinked or junctioned checkout would run nothing and print no LEG markers), whereas
// this can only skip the leg under vitest, which imports the classifiers above and must not start one.
if (!process.env.VITEST) {
  await main()
}
