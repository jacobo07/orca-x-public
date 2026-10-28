// Pure pieces of the dirty-state capsule (phase 17, D-17/D-19): omission rules, message and trailer shape.
export const CAPSULE_REF_PREFIX = 'refs/orca/capsules/'
export const CAPSULE_VERSION = '1'
export const CAPSULE_MAX_FILE_BYTES = 50 * 1024 * 1024
export const CAPSULE_MAX_UNTRACKED_BYTES = 512 * 1024 * 1024
export const CAPSULE_MAX_OMISSION_LINES = 200
export const CAPSULE_IDENTITY = { name: 'Orca Capsule', email: 'capsule@orca.invalid' } as const

export type CapsuleOmissionReason =
  | 'secret-shaped'
  | 'too-large'
  | 'budget-exceeded'
  | 'nested-repo'
  | 'unreadable'

export type CapsuleOmission = { reason: CapsuleOmissionReason; path: string }

const SECRET_BASENAMES = [
  /^\.env$/,
  /^\.env\..+/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /^id_rsa/,
  /^id_ed25519/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.netrc$/,
  /\.kdbx$/,
  /^credentials.*\.json$/
]
const SECRET_DIRS = new Set(['.aws', '.ssh'])

/** True when an untracked path looks like a secret (D-19 denylist). Tracked files are never passed here. */
export function isSecretShapedPath(path: string): boolean {
  const parts = path.split('/').filter(Boolean)
  if (parts.slice(0, -1).some((p) => SECRET_DIRS.has(p)) || (parts.length > 0 && path.endsWith('/') && SECRET_DIRS.has(parts.at(-1)!))) {
    return true
  }
  const base = parts.at(-1) ?? ''
  return SECRET_BASENAMES.some((re) => re.test(base))
}

export function capsuleRef(wSha: string): string {
  return `${CAPSULE_REF_PREFIX}${wSha}`
}

export function buildCapsuleMessage(args: {
  base: string
  branch: string
  omissions: CapsuleOmission[]
}): string {
  const sorted = [...args.omissions].sort((a, b) =>
    `${a.reason}:${a.path}` < `${b.reason}:${b.path}` ? -1 : 1
  )
  const lines = [
    'orca capsule',
    '',
    `Orca-Capsule-Version: ${CAPSULE_VERSION}`,
    `Orca-Base: ${args.base}`,
    `Orca-Branch: ${args.branch}`,
    `Orca-Omitted: ${sorted.length}`
  ]
  for (const o of sorted.slice(0, CAPSULE_MAX_OMISSION_LINES)) {
    lines.push(`Orca-Omitted-Path: ${o.reason}:${o.path.replace(/[\r\n]/g, '?')}`)
  }
  if (sorted.length > CAPSULE_MAX_OMISSION_LINES) {
    lines.push(`Orca-Omitted-Truncated: ${sorted.length - CAPSULE_MAX_OMISSION_LINES}`)
  }
  return `${lines.join('\n')}\n`
}

export function parseCapsuleTrailers(message: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of message.split('\n')) {
    const m = /^(Orca-[A-Za-z-]+): (.*)$/.exec(line)
    if (m && !(m[1] in out)) {
      out[m[1]] = m[2]
    }
  }
  return out
}
