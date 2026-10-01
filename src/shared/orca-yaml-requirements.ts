import { parseDocument } from 'yaml'
import {
  isOrcaYamlTextWithinLimit,
  MAX_ORCA_YAML_ALIAS_COUNT,
  MAX_ORCA_YAML_COLLECTION_ENTRIES
} from './orca-yaml-file-limit'
import { ORCA_VM_RECIPE_ID_PATTERN } from './orca-yaml'
import {
  asRequirementRecord,
  asRequirementString,
  readCommonFields,
  readEvaluatedKind
} from './orca-yaml-requirement-kinds'
import {
  EVALUATED_REQUIREMENT_KINDS,
  type EnvironmentRequirement,
  type EvaluatedRequirementKind,
  type RequirementDiagnostic,
  type RequirementsParseResult
} from './environment-requirement-types'

const KIND_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

function isEvaluatedKind(kind: string): kind is EvaluatedRequirementKind {
  return (EVALUATED_REQUIREMENT_KINDS as readonly string[]).includes(kind)
}

type EntryContext = {
  index: number
  seenIds: Set<string>
  diagnostics: RequirementDiagnostic[]
}

function normalizeEntry(entry: unknown, context: EntryContext): EnvironmentRequirement {
  const { index, seenIds, diagnostics } = context
  const report = (field: string | undefined, message: string): void => {
    diagnostics.push({ index, ...(field ? { field } : {}), message })
  }
  const record = asRequirementRecord(entry)
  if (!record) {
    report(undefined, 'Requirement entry must be a mapping.')
    return { id: `#${index}`, kind: 'unknown', malformed: true }
  }
  const kind = asRequirementString(record.kind) ?? ''
  const id = asRequirementString(record.id)
  if (!id) {
    report('id', 'Requirement id is required.')
    return { id: `#${index}`, kind, malformed: true }
  }
  if (!ORCA_VM_RECIPE_ID_PATTERN.test(id)) {
    report(
      'id',
      `Invalid requirement id "${id}". Use 1-64 lowercase letters, numbers, dots, underscores or hyphens.`
    )
    return { id, kind, malformed: true }
  }
  if (seenIds.has(id)) {
    report('id', `Duplicate requirement id "${id}". Requirement ids must be unique.`)
    // Why: a distinct id keeps the duplicate addressable without ever replacing the first row.
    return { id: `${id}#${index}`, kind, malformed: true }
  }
  seenIds.add(id)
  if (!KIND_PATTERN.test(kind)) {
    report('kind', 'Requirement kind is required (letters, digits, - _).')
    return { id, kind: '', malformed: true }
  }
  if (!isEvaluatedKind(kind)) {
    return { id, kind, unsupportedByThisOrca: true }
  }
  const common = readCommonFields(record, report)
  const part = common ? readEvaluatedKind(kind, record, report) : null
  if (!common || !part) {
    return { id, kind, malformed: true }
  }
  return { id, ...part, ...common } as EnvironmentRequirement
}

/**
 * Parse the `requirements:` section of an orca.yaml. Unlike `parseOrcaYaml`, "could not read it"
 * (`unparseable`) is distinct from "does not declare any" (`absent`), so a damaged file is never
 * measured as zero requirements.
 */
export function parseOrcaYamlRequirements(content: string): RequirementsParseResult {
  if (!isOrcaYamlTextWithinLimit(content)) {
    return { status: 'unparseable', reason: 'too-large' }
  }
  let root: unknown
  try {
    const document = parseDocument(content, {
      keepSourceTokens: false,
      logLevel: 'silent',
      prettyErrors: false,
      uniqueKeys: true
    })
    if (document.errors.length > 0) {
      return { status: 'unparseable', reason: 'yaml-error' }
    }
    root = document.toJS({ maxAliasCount: MAX_ORCA_YAML_ALIAS_COUNT })
  } catch {
    return { status: 'unparseable', reason: 'yaml-error' }
  }
  const record = asRequirementRecord(root)
  if (!record || !('requirements' in record)) {
    return { status: 'absent' }
  }
  const value = record.requirements
  if (!Array.isArray(value)) {
    return { status: 'unparseable', reason: 'not-a-list' }
  }
  if (value.length > MAX_ORCA_YAML_COLLECTION_ENTRIES) {
    return { status: 'unparseable', reason: 'too-many-entries' }
  }
  const diagnostics: RequirementDiagnostic[] = []
  const seenIds = new Set<string>()
  const requirements = value.map((entry, index) =>
    normalizeEntry(entry, { index, seenIds, diagnostics })
  )
  return { status: 'parsed', requirements, diagnostics }
}
