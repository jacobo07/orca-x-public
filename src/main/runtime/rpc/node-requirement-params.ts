import { z } from 'zod'

const ByteCount = z.number().finite().positive()

// Why: one wire shape for a resource requirement, mirroring NodeRequirement; strict so an unknown key fails closed.
export const NodeRequirementParams = z
  .object({
    memory: z.object({ minAvailableBytes: ByteCount }).strict().optional(),
    disk: z
      .object({ minAvailableBytes: ByteCount, path: z.string().min(1).optional() })
      .strict()
      .optional(),
    vram: z.object({ minFreeBytes: ByteCount }).strict().optional(),
    residentModel: z
      .object({ modelId: z.string().min(1).optional() })
      .strict()
      .optional()
  })
  .strict()
