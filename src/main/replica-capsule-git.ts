// Local git runner for the capsule: gitSpawn keeps WSL routing; every child is awaited to close.
import { gitSpawn } from './git/runner'
import type { CapsuleGitRun } from './replica-capsule'

export const localCapsuleGit: CapsuleGitRun = (argv, { cwd, env, input }) =>
  new Promise((resolve, reject) => {
    const child = gitSpawn(argv, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'))
      } else {
        reject(new Error(`git ${argv[0]} exited ${code}: ${Buffer.concat(err).toString('utf8')}`))
      }
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input ?? '')
  })
