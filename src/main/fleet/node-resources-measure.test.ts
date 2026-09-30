import { describe, expect, it } from 'vitest'
import {
  measureDisk,
  measureGpu,
  measureModels,
  measureNodeResources,
  parseModelsResponse,
  parseNvidiaSmiCsv
} from './node-resources-measure'

const MIB = 1024 * 1024
// Captured on GEX44 2026-09-30 (05-RESEARCH Q6): real strings, not invented ones.
const GEX44_SMI_LINE = 'NVIDIA RTX 4000 SFF Ada Generation, 20475, 16965, 3054\n'
const GEX44_MODELS_BODY = JSON.stringify({
  object: 'list',
  data: [
    {
      id: 'qwen3-coder-30b',
      object: 'model',
      owned_by: 'llamacpp',
      meta: { n_ctx: 32768, n_ctx_train: 262144, n_params: 30532122624, size: 18550716416 }
    }
  ]
})

function expectNoNumbers(reading: object): void {
  expect(reading).toMatchObject({ outcome: 'unknown' })
  for (const value of Object.values(reading)) {
    expect(typeof value).not.toBe('number')
  }
}

describe('parseNvidiaSmiCsv', () => {
  it('parses the real GEX44 line into bytes', () => {
    expect(parseNvidiaSmiCsv(GEX44_SMI_LINE)).toEqual({
      outcome: 'measured',
      gpus: [
        {
          name: 'NVIDIA RTX 4000 SFF Ada Generation',
          totalBytes: 20475 * MIB,
          freeBytes: 3054 * MIB
        }
      ]
    })
  })

  it.each([
    ['N/A total', 'GPU, [N/A], 10, 5'],
    ['N/A free', 'GPU, 100, 10, [N/A]'],
    ['Not Supported', 'GPU, [Not Supported], [Not Supported], [Not Supported]'],
    ['empty output', ''],
    ['whitespace only', '  \n'],
    ['three columns', 'GPU, 100, 10'],
    ['five columns', 'GPU, 100, 10, 5, 1'],
    ['negative free', 'GPU, 100, 10, -5'],
    ['non-integer', 'GPU, 100, 10, 5.5'],
    ['free greater than total', 'GPU, 100, 10, 101'],
    ['used greater than total', 'GPU, 100, 101, 5']
  ])('is unknown malformed, never a number, for %s', (_label, stdout) => {
    const reading = parseNvidiaSmiCsv(stdout)
    expect(reading).toMatchObject({ outcome: 'unknown', reason: 'malformed' })
    expectNoNumbers(reading)
  })

  it('reads two well-formed lines as two GPUs', () => {
    const reading = parseNvidiaSmiCsv('GPU A, 100, 40, 60\nGPU B, 200, 150, 50\n')
    expect(reading).toMatchObject({ outcome: 'measured' })
    if (reading.outcome === 'measured') {
      expect(reading.gpus.map((gpu) => gpu.name)).toEqual(['GPU A', 'GPU B'])
    }
  })

  it('publishes nothing when one of several lines is malformed', () => {
    expect(parseNvidiaSmiCsv('GPU A, 100, 40, 60\nGPU B, [N/A], 150, 50\n')).toMatchObject({
      outcome: 'unknown',
      reason: 'malformed'
    })
  })

  it('keeps a genuinely measured 0 free representable', () => {
    const reading = parseNvidiaSmiCsv('NVIDIA RTX 4000 SFF Ada Generation, 20475, 20475, 0')
    expect(reading).toMatchObject({ outcome: 'measured' })
    if (reading.outcome === 'measured') {
      expect(reading.gpus[0].freeBytes).toBe(0)
    }
  })
})

describe('parseModelsResponse', () => {
  it('reads the real GEX44 body as one model id', () => {
    expect(parseModelsResponse(GEX44_MODELS_BODY)).toEqual({
      outcome: 'measured',
      modelIds: ['qwen3-coder-30b']
    })
  })

  it.each([
    ['empty data', JSON.stringify({ object: 'list', data: [] })],
    ['non-JSON', 'not json'],
    ['data not an array', JSON.stringify({ data: 'x' })],
    ['id not a string', JSON.stringify({ data: [{ id: 7 }] })],
    ['empty id', JSON.stringify({ data: [{ id: '' }] })],
    ['over the size cap', JSON.stringify({ data: [{ id: 'x'.repeat(1024 * 1024) }] })]
  ])('is unknown malformed for %s', (_label, body) => {
    expect(parseModelsResponse(body)).toMatchObject({ outcome: 'unknown', reason: 'malformed' })
  })
})

describe('measureGpu', () => {
  const failing = (error: object) => ({
    runNvidiaSmi: () => Promise.reject(Object.assign(new Error('x'), error))
  })

  it('classifies a missing tool, a timeout and a failing tool separately', async () => {
    await expect(measureGpu(failing({ code: 'ENOENT' }))).resolves.toMatchObject({
      outcome: 'unknown',
      reason: 'no-gpu-tool'
    })
    await expect(measureGpu(failing({ killed: true, signal: 'SIGTERM' }))).resolves.toMatchObject({
      outcome: 'unknown',
      reason: 'timeout'
    })
    await expect(measureGpu(failing({ code: 9 }))).resolves.toMatchObject({
      outcome: 'unknown',
      reason: 'tool-failed'
    })
  })

  it('measures from the tool output', async () => {
    const reading = await measureGpu({ runNvidiaSmi: async () => GEX44_SMI_LINE })
    expect(reading).toMatchObject({ outcome: 'measured' })
  })
})

describe('measureModels', () => {
  it('is unknown no-probe-configured without ports and fetches nothing', async () => {
    const fetched: number[] = []
    const reading = await measureModels([], {
      fetchModels: async (port) => {
        fetched.push(port)
        return GEX44_MODELS_BODY
      }
    })
    expect(reading).toMatchObject({ outcome: 'unknown', reason: 'no-probe-configured' })
    expect(fetched).toEqual([])
  })

  it('keeps the answering port and lists the silent one', async () => {
    const reading = await measureModels([8081, 8082], {
      fetchModels: async (port) => {
        if (port === 8081) {
          return GEX44_MODELS_BODY
        }
        throw new Error('refused')
      }
    })
    expect(reading).toEqual({
      outcome: 'measured',
      endpoints: [{ port: 8081, modelIds: ['qwen3-coder-30b'] }],
      unansweredPorts: [8082]
    })
  })

  it('is unknown endpoint-unreachable when every port fails', async () => {
    const reading = await measureModels([9001, 9002], {
      fetchModels: () => Promise.reject(new Error('refused'))
    })
    expect(reading).toMatchObject({ outcome: 'unknown', reason: 'endpoint-unreachable' })
  })

  it('rejects too many or out-of-range ports before any fetch', async () => {
    const fetched: number[] = []
    const deps = {
      fetchModels: async (port: number) => {
        fetched.push(port)
        return GEX44_MODELS_BODY
      }
    }
    for (const ports of [[1, 2, 3, 4, 5], [0], [65536], [1.5], [-1]]) {
      await expect(measureModels(ports, deps)).resolves.toMatchObject({
        outcome: 'unknown',
        reason: 'rejected'
      })
    }
    expect(fetched).toEqual([])
  })
})

describe('measureDisk', () => {
  it('uses available-to-unprivileged blocks and records the path', async () => {
    const reading = await measureDisk(['/data'], {
      statfs: async () => ({ bavail: 10, bfree: 99, blocks: 100, bsize: 4096 }),
      rootOf: () => '/data'
    })
    expect(reading).toEqual({
      outcome: 'measured',
      filesystems: [{ path: '/data', totalBytes: 100 * 4096, availableBytes: 10 * 4096 }]
    })
  })

  it('dedupes identical paths and keeps the survivor when one path fails', async () => {
    const reading = await measureDisk(['/data', '/data', '/'], {
      statfs: async (path) => {
        if (path === '/') {
          throw new Error('EACCES')
        }
        return { bavail: 1, bfree: 1, blocks: 2, bsize: 512 }
      },
      rootOf: () => '/'
    })
    expect(reading).toEqual({
      outcome: 'measured',
      filesystems: [{ path: '/data', totalBytes: 1024, availableBytes: 512 }]
    })
  })

  it('is unknown tool-failed when every path fails', async () => {
    const reading = await measureDisk(['/a', '/b'], {
      statfs: () => Promise.reject(new Error('EIO')),
      rootOf: () => '/'
    })
    expect(reading).toMatchObject({ outcome: 'unknown', reason: 'tool-failed' })
  })
})

describe('measureNodeResources', () => {
  it('never rejects and returns three unknown readings when every dependency throws', async () => {
    const boom = () => {
      throw new Error('boom')
    }
    const reply = await measureNodeResources(
      { dataPath: '/data', modelProbePorts: [8081] },
      {
        runNvidiaSmi: boom,
        statfs: boom,
        fetchModels: boom,
        rootOf: boom
      }
    )
    expect(reply.schema).toBe('orca.node-resources/1')
    expect(reply.disk.outcome).toBe('unknown')
    expect(reply.gpu.outcome).toBe('unknown')
    expect(reply.models.outcome).toBe('unknown')
  })

  it('takes probe ports as input: none configured means unknown, never a default port', async () => {
    const reply = await measureNodeResources(
      { dataPath: '/data' },
      {
        runNvidiaSmi: async () => GEX44_SMI_LINE,
        statfs: async () => ({ bavail: 1, bfree: 1, blocks: 2, bsize: 512 }),
        fetchModels: async () => GEX44_MODELS_BODY,
        rootOf: () => '/'
      }
    )
    expect(reply.models).toMatchObject({ outcome: 'unknown', reason: 'no-probe-configured' })
    expect(reply.gpu.outcome).toBe('measured')
    expect(reply.disk.outcome).toBe('measured')
  })
})
