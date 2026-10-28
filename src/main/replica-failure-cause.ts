// The one disk-full classifier (row 65): a full local disk must not read as a dropped connection.
export type ReplicaFailureCause = 'disk-full'

const DISK_FULL_CODES = new Set(['ENOSPC', 'EDQUOT'])
// Git and the OS word the same condition differently; nothing broader than these phrases counts.
const DISK_FULL_WORDING =
  /no space left on device|disk quota exceeded|not enough space on the disk/i

function text(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return Buffer.isBuffer(value) ? value.toString('utf8') : ''
}

function carriesDiskFull(error: object): boolean {
  const { code, errno, message, stderr } = error as Record<string, unknown>
  for (const id of [code, errno]) {
    if (typeof id === 'string' && DISK_FULL_CODES.has(id)) {
      return true
    }
  }
  return DISK_FULL_WORDING.test(text(message)) || DISK_FULL_WORDING.test(text(stderr))
}

/** True only for a local out-of-space error; connection errors, EACCES and unrelated text are not. */
export function isDiskFullError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  if (carriesDiskFull(error)) {
    return true
  }
  const { cause } = error as { cause?: unknown }
  return typeof cause === 'object' && cause !== null && cause !== error && carriesDiskFull(cause)
}
