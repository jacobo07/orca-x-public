import { useLocalSearchParams } from 'expo-router'
import { MobileWorkspaceRoster } from '../../../../src/workspace/MobileWorkspaceRoster'
import { firstParam } from '../../../../src/source-control/mobile-source-control-screen-state'

export default function MobileWorkspaceScreen() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  return <MobileWorkspaceRoster hostId={firstParam(params.hostId)} />
}
