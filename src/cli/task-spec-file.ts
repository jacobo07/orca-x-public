import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { RuntimeClientError } from './runtime/types'
import { getOptionalStringFlag } from './flags'

/**
 * `task-create --spec-file <path>`: the task text from a file instead of argv, so a long spec is
 * not bounded by the command-line limit nor visible to process listings. The body sent to the
 * server is identical to the --spec form (no path field), so the receipt hash covers the text only.
 */
export const MAX_TASK_SPEC_FILE_BYTES = 256 * 1024

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const

function unreadable(path: string, error: unknown): RuntimeClientError {
  return new RuntimeClientError(
    'spec_file_unreadable',
    `Cannot read --spec-file ${path}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`
  )
}

// Why one descriptor and a bounded read: a device, FIFO or /proc file reports size 0, so a
// stat-then-readFile check would read without limit before refusing.
function readAtMost(path: string, limit: number): Buffer {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    throw unreadable(path, error)
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new RuntimeClientError(
        'spec_file_unreadable',
        `--spec-file ${path} is not a regular file.`
      )
    }
    const buffer = Buffer.alloc(limit)
    let length = 0
    while (length < limit) {
      const read = readSync(fd, buffer, length, limit - length, null)
      if (read === 0) {
        break
      }
      length += read
    }
    return buffer.subarray(0, length)
  } catch (error) {
    throw error instanceof RuntimeClientError ? error : unreadable(path, error)
  } finally {
    closeSync(fd)
  }
}

export function readTaskSpecFile(path: string): string {
  // Why +1: reading one byte past the limit is how an oversize file is told apart from an exact fit.
  const bytes = readAtMost(path, MAX_TASK_SPEC_FILE_BYTES + 1)
  if (bytes.length > MAX_TASK_SPEC_FILE_BYTES) {
    throw new RuntimeClientError(
      'spec_file_too_large',
      `--spec-file is over the limit of ${MAX_TASK_SPEC_FILE_BYTES} bytes (256 KiB).`
    )
  }
  // Why refuse, not strip: the same text by file and by --spec must give the same task.
  if (UTF8_BOM.every((byte, index) => bytes[index] === byte)) {
    throw new RuntimeClientError(
      'spec_file_bom',
      '--spec-file starts with a UTF-8 byte-order mark; save it as UTF-8 without BOM.'
    )
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new RuntimeClientError('spec_file_not_utf8', '--spec-file is not valid UTF-8.')
  }
  if (text.length === 0) {
    throw new RuntimeClientError('invalid_argument', '--spec-file is empty.')
  }
  return text
}

/** The task text from exactly one of --spec or --spec-file. Never prints the text. */
export function resolveTaskSpec(flags: Map<string, string | boolean>): string {
  const hasSpec = flags.has('spec')
  const hasSpecFile = flags.has('spec-file')
  if (hasSpec && hasSpecFile) {
    throw new RuntimeClientError('invalid_argument', 'Use either --spec or --spec-file, not both.')
  }
  if (hasSpecFile) {
    const path = getOptionalStringFlag(flags, 'spec-file')
    if (!path) {
      throw new RuntimeClientError('invalid_argument', 'Missing value for --spec-file.')
    }
    return readTaskSpecFile(path)
  }
  const spec = flags.get('spec')
  if (typeof spec === 'string' && spec.length > 0) {
    return spec
  }
  throw new RuntimeClientError('invalid_argument', 'Missing required --spec or --spec-file')
}
