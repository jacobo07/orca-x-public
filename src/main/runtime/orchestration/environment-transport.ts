import { fingerprintHostKeyBytes } from '../host-key-fingerprint'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../shared/runtime-rpc-envelope'

export type OrchestrationWorkerServer = {
  environmentId: string
  name: string
  peerFingerprint: string
}

export type OrchestrationEnvironmentTransport = {
  resolve(selector: string): OrchestrationWorkerServer
  call(
    selector: string,
    method: string,
    params: unknown,
    timeoutMs?: number,
    envelope?: RuntimeOrchestrationEnvelope
  ): Promise<RuntimeRpcResponse<unknown>>
}

// Why: lenient on purpose so recorded peer fingerprints keep matching; fleet identity
// uses the validating fingerprintHostPublicKey over the same hash.
export function fingerprintOrchestrationPeer(publicKeyB64: string): string {
  return fingerprintHostKeyBytes(Buffer.from(publicKeyB64, 'base64'))
}
