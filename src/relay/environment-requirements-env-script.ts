import path from 'node:path'
import { ENV_NAME_PATTERN } from '../shared/environment-requirement-probe-core'

export const ENV_PRESENT_MARKER = '__ORCA_ENV_PRESENT__'

// Presence only: the script tests whether the variable is set and prints a fixed marker. The value
// is never expanded into output, so it cannot cross the wire even by accident.
export function buildEnvPresenceScript(shellFile: string, name: string): string {
  // Why: the name is interpolated into shell text, so only the closed env-name grammar may reach it.
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid environment variable name: ${name}`)
  }
  if (path.posix.basename(shellFile).toLowerCase() === 'fish') {
    return `if set -q ${name}; printf '${ENV_PRESENT_MARKER}\\n'; end`
  }
  return `if [ -n "\${${name}+x}" ]; then printf '${ENV_PRESENT_MARKER}\\n'; fi`
}

// Login shells print banners and startup chatter, so match the marker on a line of its own.
export function hasEnvPresentMarker(output: string): boolean {
  return output.split(/\r?\n/).some((line) => line.trim() === ENV_PRESENT_MARKER)
}
