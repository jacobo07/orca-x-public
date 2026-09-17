/*
 * Scales a REAL captured working set to N rows for the R3 density lab.
 *
 * The producer defines the shape; this synthesizes cardinality and nothing else. Every field the
 * capture wrote is copied verbatim except the ones that must be unique per row — tab id, leaf id and
 * provider session id — which are regenerated through the caller's canonical id source. A
 * hand-authored manifest would test a shape the producer never emits; a clone that reuses identities
 * would make two rows claim one session.
 *
 * Labels are deliberately NOT freshened: clones share their source's title, so identity can only be
 * resolved by tab id. That duplicate is what makes a title-keyed revival bug observable.
 */
import type {
  ProjectWorkingSetManifest,
  WorkingSetEntry,
  WorkingSetPane
} from './project-working-set-types'

export type ScaleCloneOptions = {
  /** Canonical identity source. Must return a fresh UUID: a patterned fake stops being one at scale. */
  newId: () => string
  /** Manifest id for the scaled copy; defaults to a fresh one. */
  workingSetId?: string
}

function clonePane(
  pane: WorkingSetPane,
  index: number,
  options: ScaleCloneOptions
): WorkingSetPane {
  const resume =
    pane.resume.kind === 'provider-session'
      ? {
          ...pane.resume,
          providerSession: { ...pane.resume.providerSession, id: options.newId() }
        }
      : pane.resume
  void index
  return { ...pane, leafId: options.newId(), resume }
}

function cloneEntry(source: WorkingSetEntry, index: number, options: ScaleCloneOptions) {
  const panes = source.panes.map((pane, paneIndex) => clonePane(pane, paneIndex, options))
  const activeIndex = source.panes.findIndex((pane) => pane.leafId === source.activeLeafId)
  const entry: WorkingSetEntry = {
    ...source,
    tabId: options.newId(),
    panes,
    activeLeafId: activeIndex >= 0 ? panes[activeIndex].leafId : null
  }
  return { entry, sourceTabId: source.tabId, index }
}

/**
 * Returns `manifest` with exactly `rows` entries, cycling through the captured ones so every source
 * shape is represented. Rail-group membership follows each clone's source entry, so the captured
 * grouping ratio survives; revival order and the active row are remapped to the clones that stand
 * for them.
 */
export function cloneWorkingSetToScale(
  manifest: ProjectWorkingSetManifest,
  rows: number,
  options: ScaleCloneOptions
): ProjectWorkingSetManifest {
  if (!Number.isInteger(rows) || rows < 1) {
    throw new Error(`rows must be a positive integer, got ${String(rows)}`)
  }
  if (manifest.entries.length === 0) {
    throw new Error('cannot scale a manifest with no entries')
  }
  const groupIndexBySourceTabId = new Map<string, number>()
  manifest.railGroups.forEach((group, groupIndex) => {
    for (const tabId of group) {
      groupIndexBySourceTabId.set(tabId, groupIndex)
    }
  })

  const clones = Array.from({ length: rows }, (_, index) =>
    cloneEntry(manifest.entries[index % manifest.entries.length], index, options)
  )

  const railGroups: string[][] = manifest.railGroups.map(() => [])
  for (const clone of clones) {
    const groupIndex = groupIndexBySourceTabId.get(clone.sourceTabId) ?? 0
    railGroups[groupIndex].push(clone.entry.tabId)
  }

  // A rail group the reader would reject as empty cannot exist: at low row counts not every
  // captured group receives a clone.
  const populated = railGroups.filter((group) => group.length > 0)

  const firstCloneOf = new Map<string, string>()
  for (const clone of clones) {
    if (!firstCloneOf.has(clone.sourceTabId)) {
      firstCloneOf.set(clone.sourceTabId, clone.entry.tabId)
    }
  }

  return {
    ...manifest,
    workingSetId: options.workingSetId ?? options.newId(),
    railGroups: populated,
    revivalOrder: manifest.revivalOrder
      .map((tabId) => firstCloneOf.get(tabId))
      .filter((tabId): tabId is string => tabId !== undefined),
    activeTabId:
      manifest.activeTabId === null ? null : (firstCloneOf.get(manifest.activeTabId) ?? null),
    entries: clones.map((clone) => clone.entry)
  }
}
