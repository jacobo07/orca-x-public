import { Folder, GitBranch, ListChecks } from 'lucide-react-native'
import { MobileAgentSessionHistoryIcon } from '../agent-history/MobileAgentSessionHistoryIcon'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { colors } from '../theme/mobile-theme'

type Props = {
  visible: boolean
  showFiles: boolean
  showSourceControl: boolean
  showAgentSessionHistory: boolean
  showChecks: boolean
  onOpenFiles: () => void
  onOpenSourceControl: () => void
  onOpenAgentSessionHistory: () => void
  onOpenChecks: () => void
  onClose: () => void
}

export function MobileSessionHeaderMoreActionsSheet({
  visible,
  showFiles,
  showSourceControl,
  showAgentSessionHistory,
  showChecks,
  onOpenFiles,
  onOpenSourceControl,
  onOpenAgentSessionHistory,
  onOpenChecks,
  onClose
}: Props) {
  return (
    <ActionSheetModal
      visible={visible}
      actions={[
        ...(showFiles
          ? [{ label: 'Files', hint: 'Open file explorer', icon: Folder, onPress: onOpenFiles }]
          : []),
        ...(showSourceControl
          ? [
              {
                label: 'Source control',
                hint: 'Open source control',
                icon: GitBranch,
                onPress: onOpenSourceControl
              }
            ]
          : []),
        ...(showAgentSessionHistory
          ? [
              {
                label: 'Agent History',
                hint: 'Browse and resume agent sessions',
                renderIcon: () => (
                  <MobileAgentSessionHistoryIcon
                    size={16}
                    color={colors.textSecondary}
                    strokeWidth={2.1}
                  />
                ),
                onPress: onOpenAgentSessionHistory
              }
            ]
          : []),
        ...(showChecks
          ? [
              {
                label: 'Checks',
                hint: 'Open pull request checks',
                icon: ListChecks,
                onPress: onOpenChecks
              }
            ]
          : [])
      ]}
      onClose={onClose}
    />
  )
}
