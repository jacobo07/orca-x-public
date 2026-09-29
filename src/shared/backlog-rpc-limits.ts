// Shared by the zod RPC params and the stored-record validators so the two cannot drift.
export const BACKLOG_TEXT_MAX = 20_000
export const BACKLOG_NORMALIZED_INTENT_MAX = 2_000
export const BACKLOG_INGEST_BATCH_MAX = 200
export const BACKLOG_REF_MAX = 1_024
export const BACKLOG_FINGERPRINT_MAX = 256
export const BACKLOG_SHORT_TEXT_MAX = 500
export const BACKLOG_PROJECT_ID_MAX = 200
export const BACKLOG_PROJECT_REFS_MAX = 32
export const BACKLOG_DEPENDENCIES_MAX = 64
export const BACKLOG_EVIDENCE_PER_UPDATE_MAX = 32
export const BACKLOG_LIST_LIMIT_DEFAULT = 100
export const BACKLOG_LIST_LIMIT_MAX = 500
export const BACKLOG_RECORD_MAX_BYTES = 1_048_576
export const BACKLOG_OPEN_CONCURRENCY = 16
