import type { NodeManifest, NodeManifestsResult, NodeMeasurement } from '../shared/node-manifest'
import { measurementAgeMs } from '../shared/node-measurement-age'
import { formatByteCount } from './workspace-format'

/** 0: the manifests were read · 1: this machine could not ask. */
export function nodeManifestsExitCode(result: NodeManifestsResult): number {
  return result.status === 'ok' ? 0 : 1
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`
}

function describeMeasurement<V>(
  measurement: NodeMeasurement<V>,
  observedAt: number,
  describeValue: (value: V) => string
): string {
  if (measurement.status === 'unknown') {
    return `unknown (${measurement.reason})`
  }
  const age = seconds(measurementAgeMs(measurement.measured_at, observedAt))
  return `${describeValue(measurement.value)} — measured ${age} ago, trusted for ${seconds(measurement.max_age_ms)} (${measurement.source})`
}

function describeNode(manifest: NodeManifest, observedAt: number): string[] {
  const { node, measurements } = manifest
  const key = node.fingerprint === null ? 'unkeyed' : `key ${node.fingerprint}`
  return [
    `${node.label} (${node.address}) — ${key}`,
    `  memory: ${describeMeasurement(measurements.memory, observedAt, (v) => `${formatByteCount(v.available_bytes)} available of ${formatByteCount(v.total_bytes)}`)}`,
    `  disk: ${describeMeasurement(measurements.disk, observedAt, (v) => v.filesystems.map((fs) => `${fs.path} ${formatByteCount(fs.available_bytes)} free of ${formatByteCount(fs.total_bytes)}`).join('; '))}`,
    `  vram: ${describeMeasurement(measurements.vram, observedAt, (v) => v.gpus.map((gpu) => `${gpu.name} ${formatByteCount(gpu.free_bytes)} free of ${formatByteCount(gpu.total_bytes)}`).join('; '))}`,
    `  resident model: ${describeMeasurement(measurements.resident_model, observedAt, (v) => [...v.endpoints.map((endpoint) => `port ${endpoint.port}: ${endpoint.model_ids.join(', ') || 'no models'}`), ...(v.unanswered_ports.length > 0 ? [`no answer on ${v.unanswered_ports.join(', ')}`] : [])].join('; ') || 'no endpoints probed')}`
  ]
}

export function formatNodeManifests(result: NodeManifestsResult): string {
  if (result.status === 'refused') {
    return 'fleet manifest: refused — only this machine may ask for its fleet view.'
  }
  if (result.status === 'unavailable') {
    return 'fleet manifest: unavailable — this Orca process has no fleet reader.'
  }
  const lines = result.manifests.flatMap((manifest) => describeNode(manifest, result.observedAt))
  lines.push(
    'A value past its trusted age, or never measured, is shown as unknown. SSH targets are not enumerated.'
  )
  return lines.join('\n')
}
