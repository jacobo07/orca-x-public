#!/usr/bin/env node
// What each line still owes an integration branch, probed in merge order.
// Pairwise merge-tree against the base misses conflicts BETWEEN lines (two lines
// appending to one list merge cleanly alone and conflict together), so every
// probe runs against the cumulative result of the lines before it.
//
// Usage: node config/scripts/integration-frontier.mjs --target <ref> [--json]
//          <branch>[=<pinned-sha>] ...
// Exit: 0 every line merges cleanly, 1 a cumulative conflict, 2 usage/git error.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return {
      ok: true,
      out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    }
  } catch (error) {
    if (!allowFail) {
      throw error
    }
    return { ok: false, out: String(error.stdout ?? ''), status: error.status }
  }
}

function isAncestor(cwd, ancestor, descendant) {
  return git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFail: true }).ok
}

export function parseLineSpec(spec) {
  const at = spec.indexOf('=')
  return at === -1
    ? { branch: spec, pin: null }
    : { branch: spec.slice(0, at), pin: spec.slice(at + 1) }
}

/** Probes each line against the cumulative merge of the target and every earlier clean line. */
export function integrationFrontier({ cwd, target, lines }) {
  const targetSha = git(cwd, ['rev-parse', '--verify', `${target}^{commit}`]).out.trim()
  let cumulative = targetSha
  const report = []
  for (const { branch, pin } of lines) {
    const tip = git(cwd, ['rev-parse', '--verify', `${branch}^{commit}`]).out.trim()
    const pending = git(cwd, ['rev-list', `${cumulative}..${tip}`])
      .out.split('\n')
      .filter(Boolean)
    const entry = {
      branch,
      tip,
      notInTarget: Number(git(cwd, ['rev-list', '--count', `${targetSha}..${tip}`]).out.trim()),
      pin,
      pinContained: pin ? isAncestor(cwd, pin, targetSha) : null,
      movedPastPin: pin
        ? tip !== git(cwd, ['rev-parse', '--verify', `${pin}^{commit}`]).out.trim()
        : null,
      conflicts: [],
      clean: true
    }
    if (pending.length > 0) {
      const probe = git(
        cwd,
        ['merge-tree', '--write-tree', '--name-only', '--no-messages', cumulative, tip],
        {
          allowFail: true
        }
      )
      const [tree, ...paths] = probe.out.split('\n').filter(Boolean)
      if (probe.ok) {
        cumulative = git(cwd, [
          'commit-tree',
          tree,
          '-p',
          cumulative,
          '-p',
          tip,
          '-m',
          `frontier: ${branch}`
        ]).out.trim()
      } else if (probe.status === 1) {
        entry.clean = false
        entry.conflicts = paths
      } else {
        throw new Error(`git merge-tree failed for ${branch} (status ${probe.status})`)
      }
    }
    report.push(entry)
  }
  return { target, targetSha, lines: report, clean: report.every((l) => l.clean) }
}

function render(result) {
  const rows = [`target ${result.target} @ ${result.targetSha.slice(0, 10)}`]
  for (const l of result.lines) {
    const pin = l.pin
      ? ` pin=${l.pin.slice(0, 10)} ${l.pinContained ? 'contained' : 'NOT-contained'}${l.movedPastPin ? ' moved' : ''}`
      : ''
    const state = l.clean ? 'clean' : `CONFLICT ${l.conflicts.join(', ')}`
    rows.push(
      `${l.branch} @ ${l.tip.slice(0, 10)}: ${l.notInTarget} not in target;${pin}; ${state}`
    )
  }
  return rows.join('\n')
}

function main(argv) {
  const at = argv.indexOf('--target')
  const target = at === -1 ? null : argv[at + 1]
  const json = argv.includes('--json')
  const specs = argv.filter((a, i) => a !== '--json' && a !== '--target' && i !== at + 1)
  if (!target || specs.length === 0) {
    console.error(
      'usage: integration-frontier.mjs --target <ref> [--json] <branch>[=<pinned-sha>] ...'
    )
    return 2
  }
  try {
    const result = integrationFrontier({
      cwd: process.cwd(),
      target,
      lines: specs.map(parseLineSpec)
    })
    console.log(json ? JSON.stringify(result, null, 2) : render(result))
    return result.clean ? 0 : 1
  } catch (error) {
    console.error(`integration-frontier: ${error.message}`)
    return 2
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2))
}
