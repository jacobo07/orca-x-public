import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'

import { resolveCommandPathForRelay } from './preflight-handler'
import { terminateRelaySubprocessTree } from './subprocess-tree-termination'

// What the agent-process handler asks of the host it runs on. Injected so every refusal, the kill
// escalation and the backpressure path can be driven without a real process.

export type AgentProcessHostDeps = {
  spawn: typeof nodeSpawn
  resolveCommand: (command: string) => Promise<string | null>
  /** The realpath of `target` when it is a directory, else null. */
  isDirectory: (target: string) => Promise<string | null>
  killGroup: (child: ChildProcess, signal: NodeJS.Signals) => void
  platform: NodeJS.Platform
}

export const defaultAgentProcessHostDeps: AgentProcessHostDeps = {
  spawn: nodeSpawn,
  resolveCommand: (command) => resolveCommandPathForRelay(command),
  isDirectory: async (target) => {
    try {
      const resolved = await realpath(target)
      return (await stat(resolved)).isDirectory() ? resolved : null
    } catch {
      return null
    }
  },
  killGroup: (child, signal) => {
    if (process.platform === 'win32' || child.pid === undefined) {
      terminateRelaySubprocessTree(child)
      return
    }
    try {
      // Negative pid: the whole group, so tool subprocesses the provider started die with it.
      process.kill(-child.pid, signal)
    } catch {
      // ESRCH: already gone.
    }
  },
  platform: process.platform
}
