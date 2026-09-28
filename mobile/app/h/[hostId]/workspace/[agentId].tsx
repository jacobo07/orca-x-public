import { useLocalSearchParams } from 'expo-router'
import { MobileAgentChat } from '../../../../src/workspace/MobileAgentChat'
import { firstParam } from '../../../../src/source-control/mobile-source-control-screen-state'

export default function MobileAgentChatScreen() {
  const params = useLocalSearchParams<{ hostId?: string | string[]; agentId?: string | string[] }>()
  return <MobileAgentChat hostId={firstParam(params.hostId)} agentId={firstParam(params.agentId)} />
}
