// Why: closed set so a consumer can switch on why a family is unknown instead of parsing prose.
export type NodeResourceUnknownReason =
  | 'no-gpu-tool'
  | 'tool-failed'
  | 'timeout'
  | 'malformed'
  | 'no-probe-configured'
  | 'endpoint-unreachable'
  | 'unsupported'
  | 'unreachable'
  | 'rejected'
  | 'incarnation-changed'
  | 'not-attempted'
  | 'measurer-not-installed'

// Why: only the measured arm carries numbers, so an unmeasured family can never read as 0 bytes.
type Reading<T> =
  | ({ outcome: 'measured' } & T)
  | { outcome: 'unknown'; reason: NodeResourceUnknownReason; detail?: string }

export type DiskReading = Reading<{
  filesystems: { path: string; totalBytes: number; availableBytes: number }[]
}>

export type GpuReading = Reading<{
  gpus: { name: string; totalBytes: number; freeBytes: number }[]
}>

export type ModelReading = Reading<{
  endpoints: { port: number; modelIds: string[] }[]
  unansweredPorts: number[]
}>

export type FleetNodeResourcesObservation = {
  /** Observer clock at the start of the reading, never a node-supplied time. */
  startedAt: number
  runtimeId: string | null
  disk: DiskReading
  gpu: GpuReading
  models: ModelReading
}
