import { spawnSync } from 'node:child_process'
import path from 'node:path'

import type { HwfRun } from './hwf-two-host-ssh-target'

export type RootProc = { pid: number; ppid: number; cwd: string; argv: string }

// Why: the committed provisioner's `procs` verb is the one instrument for "what runs under the root, and where".
export function listRootProcs(run: HwfRun): RootProc[] {
  const result = spawnSync(
    process.execPath,
    [path.join(process.cwd(), 'config', 'scripts', 'hwf-two-host-remote.mjs'), 'procs', run.root],
    { encoding: 'utf8' }
  )
  const procs: RootProc[] = []
  for (const line of (result.stdout ?? '').split(/\r?\n/)) {
    const match = /^PROC (\d+) (-?\d+) (\S+) (.*)$/.exec(line)
    if (match) {
      procs.push({ pid: Number(match[1]), ppid: Number(match[2]), cwd: match[3], argv: match[4] })
    }
  }
  return procs
}

// Why: agents from earlier app runs stay alive in a reused root, so attribution needs "not there before the click".
export function snapshotRootPids(run: HwfRun, pattern: RegExp): Set<number> {
  return new Set(
    listRootProcs(run)
      .filter((proc) => pattern.test(proc.argv))
      .map((proc) => proc.pid)
  )
}
