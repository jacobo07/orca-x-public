import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { provisionerSshInvocation } from './hwf-two-host-provisioner-ssh.mjs'

const REAL_SCRIPT = readFileSync(join(import.meta.dirname, 'hwf-two-host-disposable-root.sh'), 'utf8')
const WINDOWS_COMMAND_LINE_MAX = 32_767
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const bash = process.platform === 'win32' ? GIT_BASH : 'bash'

function commandLineLength(args) {
  return ['ssh', ...args].reduce((sum, arg) => sum + arg.length + 3, 0)
}

describe('provisionerSshInvocation', () => {
  it('keeps the ssh command line the same size whatever the script size', () => {
    const real = provisionerSshInvocation('gex44', REAL_SCRIPT, 'create', '/tmp/orca-hwf-p17-X')
    const huge = provisionerSshInvocation('gex44', 'x'.repeat(200_000), 'create', '/tmp/orca-hwf-p17-X')
    expect(commandLineLength(real.args)).toBe(commandLineLength(huge.args))
    expect(commandLineLength(real.args)).toBeLessThan(1_000)
    // Control: the old shape (script as a base64 argument) is over the Windows limit at today's size.
    expect(Buffer.from(REAL_SCRIPT).toString('base64').length).toBeGreaterThan(WINDOWS_COMMAND_LINE_MAX)
  })

  it('runs the script with its arguments, its exit code, and stdin at EOF', () => {
    expect(existsSync(bash) || process.platform !== 'win32').toBe(true)
    const script = 'printf "args=%s|%s|%s\\n" "$1" "$2" "$3"\nrest=$(cat)\nprintf "stdin=[%s]\\n" "$rest"\nexit 7\n'
    const { args, input } = provisionerSshInvocation('h', script, 'seed-p17', '/tmp/orca-hwf-p17-A', ['two words'])
    const result = spawnSync(bash, ['-c', args.at(-1)], { input, encoding: 'utf8' })
    expect(result.stdout).toContain('args=seed-p17|/tmp/orca-hwf-p17-A|two words')
    expect(result.stdout).toContain('stdin=[]')
    expect(result.status).toBe(7)
  })
})
