import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import type {
  DiskReading,
  GpuReading,
  ModelReading,
  NodeResourceUnknownReason
} from '../../shared/node-resources'

export const NODE_RESOURCES_SCHEMA = 'orca.node-resources/1' as const

export type NodeResourcesReply = {
  schema: typeof NODE_RESOURCES_SCHEMA
  disk: DiskReading
  gpu: GpuReading
  models: ModelReading
}

export type NodeResourcesParams = {
  dataPath?: string
  /** Loopback ports to ask GET /v1/models; empty by default so no port is ever assumed. */
  modelProbePorts?: number[]
}

type StatfsResult = { bavail: number; bfree: number; blocks: number; bsize: number }

export type MeasureDeps = {
  runNvidiaSmi: () => Promise<string>
  statfs: (path: string) => Promise<StatfsResult>
  fetchModels: (port: number) => Promise<string>
  rootOf: (path: string) => string
}

const TOOL_TIMEOUT_MS = 2_000
const TOOL_MAX_BUFFER = 64 * 1024
const MODELS_BODY_CAP_BYTES = 1024 * 1024
const MAX_PROBE_PORTS = 4
const MIB = 1024 * 1024
const NVIDIA_SMI_ARGS = [
  '--query-gpu=name,memory.total,memory.used,memory.free',
  '--format=csv,noheader,nounits'
]

type Unknown = { outcome: 'unknown'; reason: NodeResourceUnknownReason; detail?: string }

function unknown(reason: NodeResourceUnknownReason, detail?: string): Unknown {
  return detail === undefined
    ? { outcome: 'unknown', reason }
    : { outcome: 'unknown', reason, detail }
}

function parseMib(text: string): number | null {
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null
}

export function parseNvidiaSmiCsv(stdout: string): GpuReading {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) {
    return unknown('malformed', 'nvidia-smi printed no GPU line')
  }
  const gpus: { name: string; totalBytes: number; freeBytes: number }[] = []
  for (const line of lines) {
    const columns = line.split(',').map((column) => column.trim())
    if (columns.length !== 4 || columns[0] === '') {
      return unknown('malformed', 'nvidia-smi line is not name,total,used,free')
    }
    const total = parseMib(columns[1])
    const used = parseMib(columns[2])
    const free = parseMib(columns[3])
    // Why: [N/A] and [Not Supported] fail the integer test, so they can never become 0 bytes.
    if (total === null || used === null || free === null || used > total || free > total) {
      return unknown('malformed', 'nvidia-smi memory columns are not consistent integers')
    }
    gpus.push({ name: columns[0], totalBytes: total * MIB, freeBytes: free * MIB })
  }
  return { outcome: 'measured', gpus }
}

export function parseModelsResponse(
  body: string
): { outcome: 'measured'; modelIds: string[] } | Unknown {
  if (body.length > MODELS_BODY_CAP_BYTES) {
    return unknown('malformed', 'models body over the size cap')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return unknown('malformed', 'models body is not JSON')
  }
  const data = (parsed as { data?: unknown } | null)?.data
  if (!Array.isArray(data) || data.length === 0) {
    return unknown('malformed', 'models body lists no model')
  }
  const modelIds: string[] = []
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || id === '') {
      return unknown('malformed', 'a model entry has no id string')
    }
    modelIds.push(id)
  }
  return { outcome: 'measured', modelIds }
}

function classifyToolError(error: unknown): Unknown {
  const failure = error as { code?: unknown; killed?: unknown } | null
  if (failure?.code === 'ENOENT') {
    return unknown('no-gpu-tool')
  }
  if (failure?.killed === true || failure?.code === 'ETIMEDOUT') {
    return unknown('timeout')
  }
  return unknown('tool-failed')
}

export async function measureGpu(deps: Partial<MeasureDeps> = {}): Promise<GpuReading> {
  try {
    const stdout = await (deps.runNvidiaSmi ?? runNvidiaSmi)()
    return parseNvidiaSmiCsv(stdout)
  } catch (error) {
    return classifyToolError(error)
  }
}

export async function measureDisk(
  paths: string[],
  deps: Partial<MeasureDeps> = {}
): Promise<DiskReading> {
  const read = deps.statfs ?? statfs
  const filesystems: { path: string; totalBytes: number; availableBytes: number }[] = []
  for (const target of [...new Set(paths)]) {
    try {
      const stats = await read(target)
      // Why: bavail (what an unprivileged writer can use), never bfree which includes root's reserve.
      const availableBytes = stats.bavail * stats.bsize
      const totalBytes = stats.blocks * stats.bsize
      if (
        Number.isSafeInteger(availableBytes) &&
        Number.isSafeInteger(totalBytes) &&
        availableBytes >= 0 &&
        availableBytes <= totalBytes
      ) {
        filesystems.push({ path: target, totalBytes, availableBytes })
      }
    } catch {
      // Why: one unreadable path must not hide the others; it is simply not listed.
    }
  }
  return filesystems.length > 0
    ? { outcome: 'measured', filesystems }
    : unknown('tool-failed', 'no path could be read')
}

function validProbePorts(ports: number[]): boolean {
  return (
    ports.length <= MAX_PROBE_PORTS &&
    ports.every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
  )
}

export async function measureModels(
  ports: number[],
  deps: Partial<MeasureDeps> = {}
): Promise<ModelReading> {
  if (ports.length === 0) {
    return unknown('no-probe-configured')
  }
  if (!validProbePorts(ports)) {
    return unknown('rejected', 'probe ports must be at most 4 integers in 1-65535')
  }
  const fetchBody = deps.fetchModels ?? fetchModelsBody
  const endpoints: { port: number; modelIds: string[] }[] = []
  const unansweredPorts: number[] = []
  let sawMalformed = false
  for (const port of [...new Set(ports)]) {
    try {
      const parsed = parseModelsResponse(await fetchBody(port))
      if (parsed.outcome === 'measured') {
        endpoints.push({ port, modelIds: parsed.modelIds })
        continue
      }
      sawMalformed = true
    } catch {
      // Why: an unreachable port is recorded as unanswered below, not as an empty model list.
    }
    unansweredPorts.push(port)
  }
  if (endpoints.length === 0) {
    return sawMalformed
      ? unknown('malformed', 'an endpoint answered without a usable model list')
      : unknown('endpoint-unreachable', 'no probed endpoint answered')
  }
  return { outcome: 'measured', endpoints, unansweredPorts }
}

export async function measureNodeResources(
  params: NodeResourcesParams,
  deps: Partial<MeasureDeps> = {}
): Promise<NodeResourcesReply> {
  const guarded = async <T extends { outcome: string }>(
    run: () => Promise<T>,
    fallback: Unknown
  ): Promise<T | Unknown> => {
    try {
      return await run()
    } catch {
      return fallback
    }
  }
  const rootOf = deps.rootOf ?? ((target: string) => path.parse(path.resolve(target)).root)
  const [disk, gpu, models] = await Promise.all([
    guarded(async () => {
      if (!params.dataPath) {
        return unknown('not-attempted', 'no data path was given')
      }
      return measureDisk([params.dataPath, rootOf(params.dataPath)], deps)
    }, unknown('tool-failed')),
    guarded(() => measureGpu(deps), unknown('tool-failed')),
    guarded(() => measureModels(params.modelProbePorts ?? [], deps), unknown('tool-failed'))
  ])
  return { schema: NODE_RESOURCES_SCHEMA, disk, gpu, models } as NodeResourcesReply
}

function runNvidiaSmi(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'nvidia-smi',
      NVIDIA_SMI_ARGS,
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        maxBuffer: TOOL_MAX_BUFFER,
        timeout: TOOL_TIMEOUT_MS,
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(String(stdout))
      }
    )
  })
}

// Why: loopback only, GET /v1/models only, no redirect following, hard time and size caps (T-05-08).
function fetchModelsBody(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/v1/models', agent: false, timeout: TOOL_TIMEOUT_MS },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`status ${response.statusCode}`))
          return
        }
        const chunks: Buffer[] = []
        let received = 0
        response.on('data', (chunk: Buffer) => {
          received += chunk.length
          chunks.push(chunk)
          if (received > MODELS_BODY_CAP_BYTES) {
            // Why: hand the over-cap body to the parser, which refuses it as malformed.
            request.destroy()
            resolve(Buffer.concat(chunks).toString('utf8'))
          }
        })
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        response.on('error', reject)
      }
    )
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
  })
}
