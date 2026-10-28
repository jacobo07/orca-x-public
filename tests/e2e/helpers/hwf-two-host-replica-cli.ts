import { spawnSync } from 'node:child_process'
import path from 'node:path'

export type RawCliResult = { status: number; stdout: string; stderr: string }

/** Runs the built CLI against the e2e app's runtime and keeps stdout and the exit code on any exit status. */
export function runCliRaw(
  args: string[],
  userDataDir: string,
  cli = path.join(process.cwd(), 'out', 'cli', 'index.js')
): RawCliResult {
  const r = spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ORCA_USER_DATA_PATH: userDataDir, ORCA_DEV_CLI_INVOCATION: '1' },
    encoding: 'utf8',
    timeout: 60_000
  })
  // Why: a timeout or spawn failure has a null status; 124 keeps it distinguishable from every printer exit code.
  return { status: r.status ?? 124, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
