import {
  NODE_RESOURCES_SCHEMA,
  type NodeResourcesParams,
  type NodeResourcesReply
} from './node-resources-measure'

export type NodeResourcesMeasurer = (params: NodeResourcesParams) => Promise<NodeResourcesReply>

let installed: NodeResourcesMeasurer | null = null

// Why a slot: the runtime service is built in both the window and `orca serve` paths, and only
// main knows the data path the disk reading should describe.
export function installNodeResourcesMeasurer(measurer: NodeResourcesMeasurer | null): void {
  installed = measurer
}

export function readNodeResources(params: NodeResourcesParams): Promise<NodeResourcesReply> {
  if (installed) {
    return installed(params)
  }
  const unknown = { outcome: 'unknown', reason: 'measurer-not-installed' } as const
  return Promise.resolve({
    schema: NODE_RESOURCES_SCHEMA,
    disk: unknown,
    gpu: unknown,
    models: unknown
  })
}
