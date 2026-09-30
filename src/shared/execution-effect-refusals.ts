// Why: Stop Execution and Cancel Workstream are different effects with different authorities; their
// refusal vocabularies live apart so a Cancel refusal can never be read as a Stop one (or the reverse).

// Why: these are the strings the runtime already ships (renderer sleep callers read them by name), so
// they are frozen here rather than renamed.
export const STOP_EXECUTION_REFUSAL_CODES = Object.freeze([
  // Not found or already stopped: "already stopped" has no dedicated code and surfaces as the mismatch.
  'terminal_stop_pty_set_mismatch',
  'terminal_handle_stale',
  // Runtime unreachable or unable to prove liveness.
  'terminal_liveness_unavailable',
  'remote_runtime_unavailable',
  // Stop refused or failed.
  'terminal_exact_stop_requires_single_pty',
  'terminal_exact_stop_unavailable',
  'terminal_exact_stop_failed'
] as const)

export type StopExecutionRefusalCode = (typeof STOP_EXECUTION_REFUSAL_CODES)[number]

export const WORKSTREAM_AUTHORITY_UNAVAILABLE = 'workstream_authority_unavailable'

// Why: Workstream cancellation belongs to UWCP; this is the contract that would carry it.
export const UWCP_CONTROL_CONTRACT = 'uwcp.control/1'

export const CANCEL_WORKSTREAM_REFUSAL_CODES = Object.freeze([
  WORKSTREAM_AUTHORITY_UNAVAILABLE
] as const)

export type CancelWorkstreamRefusalCode = (typeof CANCEL_WORKSTREAM_REFUSAL_CODES)[number]
