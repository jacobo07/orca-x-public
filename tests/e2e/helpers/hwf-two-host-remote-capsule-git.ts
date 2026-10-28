import type { CapsuleGitRun } from '../../../src/main/replica-capsule'

// The capsule writes only these through its runner; anything else would let a caller smuggle a shell-level override.
const ALLOWED_ENV = new Set([
  'GIT_INDEX_FILE',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE'
])

export type RemoteExec = (script: string) => { status: number; out: string }

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

// Why: the existing remote runner cannot pass stdin, so input travels as base64 and is decoded in the pipeline.
export function buildRemoteCapsuleCommand(args: {
  cwd: string
  argv: string[]
  env?: Record<string, string>
  input?: string
}): string {
  const assignments = Object.entries(args.env ?? {}).map(([name, value]) => {
    if (!ALLOWED_ENV.has(name)) {
      throw new Error(`refusing remote environment variable ${name}`)
    }
    return `${name}=${quote(value)}`
  })
  const git = `${[...assignments, 'git', ...args.argv.map(quote)].join(' ')}`
  const source =
    args.input === undefined
      ? '</dev/null'
      : `printf %s ${quote(Buffer.from(args.input, 'utf8').toString('base64'))} | base64 -d |`
  const pipeline = args.input === undefined ? `${git} ${source}` : `${source} ${git}`
  // stderr stays off stdout on success so a hint line cannot corrupt a parsed sha; it is replayed on failure.
  return `e=$(mktemp); { cd ${quote(args.cwd)} && ${pipeline}; } 2>"$e"; s=$?; [ $s -eq 0 ] || cat "$e"; unlink "$e"; exit $s`
}

// Limit: createCapsule probes the index and untracked files on the CALLING host's file system, so over a remote runner
// it is only faithful for tracked edits (the staged split and untracked content are read from the wrong disk).
export function remoteCapsuleGit(exec: RemoteExec): CapsuleGitRun {
  return async (argv, options) => {
    const result = exec(buildRemoteCapsuleCommand({ argv, ...options }))
    if (result.status !== 0) {
      throw Object.assign(new Error(result.out), { code: result.status })
    }
    return result.out
  }
}
