import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Runs GSD's own read commands (`planning inspect`, `roadmap analyze`, `smart-entry --json`) so the
 * brief reuses GSD's parsers instead of keeping a second copy of them. Read-only: every command is
 * given `--cwd` (and `--ws`), so GSD's session pointer is never written.
 */

export type GsdCommand = 'planning-inspect' | 'roadmap-analyze' | 'smart-entry'

export type GsdRun = { kind: 'ok'; json: unknown } | { kind: 'failed'; detail: string }

export type GsdRunner = (
  command: GsdCommand,
  cwd: string,
  workstream: string | null
) => Promise<GsdRun>

const ARGS: Record<GsdCommand, string[]> = {
  'planning-inspect': ['planning', 'inspect'],
  'roadmap-analyze': ['roadmap', 'analyze'],
  'smart-entry': ['smart-entry', '--json']
}

// Why generous: measured 9.6 s for `planning inspect` on a host under memory pressure.
const GSD_TIMEOUT_MS = 60_000
const GSD_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export function defaultGsdToolsPath(): string {
  return path.join(homedir(), '.claude', 'gsd-core', 'bin', 'gsd-tools.cjs')
}

export function gsdToolsAvailable(toolsPath: string = defaultGsdToolsPath()): boolean {
  return existsSync(toolsPath)
}

export function createGsdRunner(toolsPath: string = defaultGsdToolsPath()): GsdRunner {
  return (command, cwd, workstream) =>
    new Promise((resolve) => {
      const args = [toolsPath, ...ARGS[command], '--cwd', cwd]
      if (workstream) {
        args.push('--ws', workstream)
      }
      execFile(
        process.execPath,
        args,
        {
          // Why ELECTRON_RUN_AS_NODE: no `node` on PATH is assumed; Orca's own runtime runs GSD.
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          timeout: GSD_TIMEOUT_MS,
          maxBuffer: GSD_MAX_OUTPUT_BYTES,
          windowsHide: true,
          encoding: 'utf8'
        },
        (error, stdout) => {
          if (error) {
            resolve({ kind: 'failed', detail: `${command}: ${error.message.split('\n')[0]}` })
            return
          }
          try {
            resolve({ kind: 'ok', json: JSON.parse(stdout.replace(/^﻿/, '')) })
          } catch {
            resolve({ kind: 'failed', detail: `${command}: output was not JSON` })
          }
        }
      )
    })
}
