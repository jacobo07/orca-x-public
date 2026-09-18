/**
 * Byte rendering for process memory, the counterpart to `resource-memory-metric-copy`:
 * that module owns which metric the number IS, this one owns how it reads.
 *
 * Deliberately not `workspace-space-format`'s `formatBytes`, which renders disk
 * sizes and disagrees at both ends (`0 B` vs `0 KB`, adaptive vs fixed precision).
 * Two surfaces in one popover spelling the same megabytes differently is the
 * divergence this file exists to prevent.
 */
export function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
