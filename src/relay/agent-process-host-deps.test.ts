import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'

import { defaultAgentProcessHostDeps } from './agent-process-host-deps'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('defaultAgentProcessHostDeps.killGroup', () => {
  // POSIX only: the relay refuses Windows hosts, and a process group is what this proves.
  it.skipIf(process.platform === 'win32')(
    'kills the subprocesses a provider started, not only the provider',
    async () => {
      const child = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const [line] = (await once(child.stdout!, 'data')) as [Buffer]
      const grandchild = Number.parseInt(line.toString().trim(), 10)
      expect(alive(grandchild)).toBe(true)
      try {
        defaultAgentProcessHostDeps.killGroup(child, 'SIGKILL')
        await once(child, 'exit')
        const deadline = Date.now() + 3000
        while (alive(grandchild) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        expect(alive(grandchild)).toBe(false)
      } finally {
        if (alive(grandchild)) {
          process.kill(grandchild, 'SIGKILL')
        }
      }
    }
  )
})
