// What a review concluded, as a structure its consumers (approvals, the Workspace) can act on.
// The reviewer is asked for one JSON block; a reply that does not follow the contract is recorded
// as `unstructured` — never guessed into a verdict — and a review that did not run is `failed`.
import type {
  ReviewFinding,
  ReviewFindingsDocument,
  ReviewSeverity,
  ReviewVerdict
} from '../../../shared/agent-federation-view'

export const REVIEW_FINDINGS_SCHEMA = 'orca.review-findings/1'

/** A patch larger than this is refused rather than truncated: a reviewer shown part of a subject
 *  would sign off on bytes it never saw. */
export const REVIEW_PATCH_MAX_CHARS = 120_000

// Why in shared: the Workspace renders this document as main stored it.
export type {
  ReviewFinding,
  ReviewFindingsDocument,
  ReviewSeverity,
  ReviewVerdict
} from '../../../shared/agent-federation-view'

const SEVERITIES: readonly ReviewSeverity[] = ['blocker', 'major', 'minor', 'note']
const VERDICTS: readonly ReviewVerdict[] = ['approve', 'changes-requested']
const EXCERPT_CHARS = 2000

export function composeReviewSpec(input: {
  projectId: string
  revision: string
  patchHash: string
  patch: string
}): string {
  return [
    `Review commit ${input.revision} in project ${input.projectId}.`,
    `The complete patch follows (sha256 ${input.patchHash}). Review only these changes; do not modify any files.`,
    '',
    '<patch>',
    input.patch,
    '</patch>',
    '',
    'End your reply with exactly one fenced ```json block of this shape:',
    '{"schema": "orca.review-findings/1", "verdict": "approve" | "changes-requested",',
    ' "findings": [{"severity": "blocker" | "major" | "minor" | "note", "summary": "...", "location": "path:line"}]}',
    'Use an empty findings array when there is nothing to report. "location" is optional.'
  ].join('\n')
}

function lastJsonBlock(text: string): string | null {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  return blocks.length > 0 ? blocks[blocks.length - 1][1] : null
}

function unstructured(problem: string, text: string): ReviewFindingsDocument {
  return { schema: REVIEW_FINDINGS_SCHEMA, kind: 'unstructured', problem, excerpt: text.slice(0, EXCERPT_CHARS) }
}

function readFinding(value: unknown): ReviewFinding | null {
  const entry = value as { severity?: unknown; summary?: unknown; location?: unknown } | null
  if (!entry || !SEVERITIES.includes(entry.severity as ReviewSeverity)) {
    return null
  }
  if (typeof entry.summary !== 'string' || !entry.summary.trim()) {
    return null
  }
  if (entry.location !== undefined && typeof entry.location !== 'string') {
    return null
  }
  return {
    severity: entry.severity as ReviewSeverity,
    summary: entry.summary.trim(),
    ...(typeof entry.location === 'string' && entry.location ? { location: entry.location } : {})
  }
}

export function parseReviewReply(text: string): ReviewFindingsDocument {
  const block = lastJsonBlock(text)
  if (block === null) {
    return unstructured('no-json-block', text)
  }
  let value: { verdict?: unknown; findings?: unknown }
  try {
    value = JSON.parse(block) as typeof value
  } catch {
    return unstructured('json-unparseable', text)
  }
  if (!VERDICTS.includes(value?.verdict as ReviewVerdict)) {
    return unstructured('verdict-missing', text)
  }
  if (!Array.isArray(value.findings)) {
    return unstructured('findings-missing', text)
  }
  const findings = value.findings.map(readFinding)
  if (findings.some((finding) => finding === null)) {
    return unstructured('finding-malformed', text)
  }
  const verdict = value.verdict as ReviewVerdict
  const read = findings as ReviewFinding[]
  return {
    schema: REVIEW_FINDINGS_SCHEMA,
    kind: 'structured',
    verdict,
    findings: read,
    blocking: verdict === 'changes-requested' || read.some((finding) => finding.severity === 'blocker')
  }
}

export function failedReview(reason: string, detail: string): ReviewFindingsDocument {
  return { schema: REVIEW_FINDINGS_SCHEMA, kind: 'failed', reason, detail }
}

export function parseReviewFindings(raw: string | null): ReviewFindingsDocument | null {
  if (!raw) {
    return null
  }
  try {
    const value = JSON.parse(raw) as { schema?: unknown }
    return value?.schema === REVIEW_FINDINGS_SCHEMA ? (value as ReviewFindingsDocument) : null
  } catch {
    return null
  }
}
