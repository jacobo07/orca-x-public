import { z } from 'zod'

/**
 * The subsets of GSD's own JSON that the brief reads. Each parse returns `null` on a shape it does
 * not recognise, so a changed GSD degrades a field to unknown instead of rendering a wrong value.
 * GSD's percentages are deliberately not read: they are plan-counted, not gate-counted.
 */

const scoped = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value: value.nullable(), scope: z.string() }).nullable().optional()

const inspectSchema = z.object({
  milestone: z
    .object({
      version: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      scope: z.string()
    })
    .nullable()
    .optional(),
  active: z
    .object({ phase: scoped(z.string()), plan: scoped(z.string()), status: scoped(z.string()) })
    .nullable()
    .optional(),
  phases: z.array(
    z.object({
      phase_id: z.string(),
      verification: z
        .object({ status: z.string(), next_action: z.string().optional() })
        .nullable()
        .optional(),
      roadmap_acceptance: z.object({ checkbox: z.boolean().nullable() }).nullable().optional()
    })
  )
})

const roadmapSchema = z.object({
  phases: z.array(
    z.object({
      number: z.string(),
      name: z.string(),
      goal: z.string().nullable().optional(),
      depends_on: z.string().nullable().optional(),
      roadmap_complete: z.boolean().nullable().optional()
    })
  )
})

const smartEntrySchema = z.object({
  situation: z.string(),
  recommended: z.string().nullable().optional(),
  actions: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      command: z.string(),
      recommended: z.boolean().optional()
    })
  )
})

export type GsdInspect = z.infer<typeof inspectSchema>
export type GsdRoadmap = z.infer<typeof roadmapSchema>
export type GsdSmartEntry = z.infer<typeof smartEntrySchema>

export function parseGsdInspect(raw: unknown): GsdInspect | null {
  const parsed = inspectSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function parseGsdRoadmap(raw: unknown): GsdRoadmap | null {
  const parsed = roadmapSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function parseGsdSmartEntry(raw: unknown): GsdSmartEntry | null {
  const parsed = smartEntrySchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** A scoped value GSD read completely; a truncated or unscoped read is not a value. */
export function scopedValue(
  field: { value: string | null; scope: string } | null | undefined
): string | null {
  return field && field.scope === 'complete' && field.value ? field.value : null
}
