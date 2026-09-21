import { translate } from '@/i18n/i18n'

export function getTerminalHostLabel(): string {
  return translate('auto.components.status.bar.resource.terminalHost.label', 'Terminal host')
}

export function getUnattributedTerminalProcessesLabel(): string {
  return translate(
    'auto.components.status.bar.resource.terminalHost.unattributedLabel',
    'Unattributed terminal processes'
  )
}

export function getUnmeasuredMemoryLabel(): string {
  return translate('auto.components.status.bar.resource.terminalHost.unmeasured', 'Unmeasured')
}

export function getUnmeasuredMemoryDescription(): string {
  return translate(
    'auto.components.status.bar.resource.terminalHost.unmeasuredDescription',
    'The process sweep failed, so per-process memory is unknown, not zero.'
  )
}
