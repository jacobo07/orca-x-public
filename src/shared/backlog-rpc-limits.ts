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
// Per-item counts: sized so a worst-case full item keeps the state headroom under the byte cap.
export const BACKLOG_EVIDENCE_PER_ITEM_MAX = 32
export const BACKLOG_EXECUTION_LINKS_PER_ITEM_MAX = 32
export const BACKLOG_SOURCE_LINKS_PER_ITEM_MAX = 32
/** Bytes a full item keeps free for transitions and a merge loser leg. */
export const BACKLOG_RECORD_STATE_HEADROOM_BYTES = 32_768
export const BACKLOG_LIST_LIMIT_DEFAULT = 100
export const BACKLOG_LIST_LIMIT_MAX = 500
export const BACKLOG_RECORD_MAX_BYTES = 1_048_576
export const BACKLOG_OPEN_CONCURRENCY = 16
