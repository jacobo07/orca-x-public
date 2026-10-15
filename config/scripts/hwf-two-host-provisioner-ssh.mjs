// Runs the disposable-root provisioner on the carrier host. The script travels on stdin: as a base64
// argument it passed Windows' 32,767-char command line at 27 KB and spawn failed with ENAMETOOLONG.
import { spawnSync } from 'node:child_process'

// The remote shell decodes stdin to a temp file and runs that file, so a verb that reads stdin
// sees EOF instead of eating the rest of the script (what `bash -s` would allow).
export function provisionerSshInvocation(carrierHost, script, verb, root, extras = []) {
  // Extras are shape-validated (no quotes), so single quotes keep a launch line as one argument.
  const tail = extras.map((extra) => ` '${extra}'`).join('')
  const remote =
    `f=$(mktemp) && base64 -d >"$f" && bash "$f" ${verb} ${root}${tail}; ` +
    `rc=$?; rm -f "$f"; exit $rc`
  return {
    args: ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', carrierHost, remote],
    input: `${Buffer.from(script, 'utf8').toString('base64')}\n`
  }
}

export function runProvisioner(carrierHost, script, verb, root, extras = [], options = {}) {
  const { args, input } = provisionerSshInvocation(carrierHost, script, verb, root, extras)
  const result = spawnSync('ssh', args, { encoding: 'utf8', input, ...options })
  const spawnError = result.error ? `HWF_SSH_SPAWN_FAILED=${result.error.code ?? result.error.message}\n` : ''
  return { status: result.status, text: `${result.stdout ?? ''}${result.stderr ?? ''}${spawnError}` }
}
