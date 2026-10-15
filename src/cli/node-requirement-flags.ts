import type { NodeRequirement } from '../shared/node-manifest-eligibility'
import { getOptionalPositiveIntegerFlag } from './flags'
import { RuntimeClientError } from './runtime/types'

const BYTES_PER_MEGABYTE = 1024 * 1024

export function megabyteFlagAsBytes(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const raw = flags.get(name)
  // Why: a valueless or empty flag reads as absent downstream, which would silently drop the need.
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing value for --${name}.`)
  }
  // Why: Number() would read 0x10 and 1e3 as 16 and 1000, which is surprising for a resource gate.
  if (!/^\d+$/.test(raw.trim())) {
    throw new RuntimeClientError('invalid_argument', `Invalid positive integer for --${name}`)
  }
  const megabytes = getOptionalPositiveIntegerFlag(flags, name)
  if (megabytes === undefined) {
    return undefined
  }
  const bytes = megabytes * BYTES_PER_MEGABYTE
  if (!Number.isSafeInteger(bytes)) {
    throw new RuntimeClientError('invalid_argument', `--${name} is too large to express in bytes`)
  }
  return bytes
}

/** One strict requirement from the resource flags; undefined when none was asked for. */
export function nodeRequirementFromFlags(
  flags: Map<string, string | boolean>,
  options: { includeMemory: boolean }
): NodeRequirement | undefined {
  const memory = options.includeMemory ? megabyteFlagAsBytes(flags, 'min-available-mb') : undefined
  const disk = megabyteFlagAsBytes(flags, 'min-disk-mb')
  const vram = megabyteFlagAsBytes(flags, 'min-vram-mb')
  const requirement: NodeRequirement = {
    ...(memory !== undefined ? { memory: { minAvailableBytes: memory } } : {}),
    ...(disk !== undefined ? { disk: { minAvailableBytes: disk } } : {}),
    ...(vram !== undefined ? { vram: { minFreeBytes: vram } } : {})
  }
  return Object.keys(requirement).length > 0 ? requirement : undefined
}
