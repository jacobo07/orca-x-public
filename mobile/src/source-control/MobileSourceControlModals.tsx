import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { ConfirmModal } from '../components/ConfirmModal'
import { PickerModal } from '../components/PickerModal'
import { openMobilePrUrl } from '../components/mobile-pr-url'
import { MobileBranchDiffPreviewDrawer } from './MobileBranchDiffPreviewDrawer'
import type { MobileSourceControlState } from './use-mobile-source-control-state'

type Props = {
  state: MobileSourceControlState
  actionSheetActions: ActionSheetAction[]
}

export function MobileSourceControlModals({ state, actionSheetActions }: Props) {
  const {
    branchDiffPreview,
    setBranchDiffPreview,
    showActionSheet,
    setShowActionSheet,
    discardTarget,
    setDiscardTarget,
    discardChange,
    hostEnforcesDiscardPrecondition,
    showBranchPicker,
    setShowBranchPicker,
    localBranches,
    createdPrUrl,
    setCreatedPrUrl,
    createdPrWarning,
    setCreatedPrWarning,
    branchLabel,
    checkoutBranch,
    runGitAction
  } = state

  return (
    <>
      <MobileBranchDiffPreviewDrawer
        branchDiffPreview={branchDiffPreview}
        onClose={() => setBranchDiffPreview(null)}
      />

      <ActionSheetModal
        visible={showActionSheet}
        title="Source Control"
        message={branchLabel}
        actions={actionSheetActions}
        onClose={() => setShowActionSheet(false)}
      />

      {/* Two modals rather than one with a warning line, because on a host that cannot check there
          is no safe destructive action to offer -- and an enabled Discard button that then refuses
          is worse than not offering it. The Close button does exactly what it says. */}
      <ConfirmModal
        visible={discardTarget !== null && hostEnforcesDiscardPrecondition}
        title="Discard Change"
        message={
          discardTarget
            ? `Discard changes to "${discardTarget.path}"? This cannot be undone.`
            : undefined
        }
        confirmLabel="Discard"
        destructive
        onConfirm={() => {
          if (discardTarget) {
            // Not runGitAction directly: the request has to carry the state this row was showing,
            // and refusing is better than discarding unchecked when it cannot.
            void discardChange(discardTarget)
          }
          // Modal visibility is derived from discardTarget — clear it so it dismisses.
          setDiscardTarget(null)
        }}
        onCancel={() => setDiscardTarget(null)}
      />

      <ConfirmModal
        visible={discardTarget !== null && !hostEnforcesDiscardPrecondition}
        title="Can't Discard Safely"
        message={
          discardTarget
            ? `This Orca host is too old to check whether "${discardTarget.path}" changed since you looked, so discarding here could destroy work you haven't seen. Update the host, or discard from the desktop.`
            : undefined
        }
        confirmLabel="Close"
        onConfirm={() => setDiscardTarget(null)}
        onCancel={() => setDiscardTarget(null)}
      />

      <PickerModal
        visible={showBranchPicker}
        title="Switch Branch"
        options={(localBranches?.branches ?? []).map((b) => ({
          value: b,
          label: b,
          subtitle: b === localBranches?.current ? 'current' : undefined
        }))}
        selected={localBranches?.current ?? ''}
        onSelect={(branch) => {
          if (branch !== localBranches?.current) {
            void checkoutBranch(branch)
          } else {
            setShowBranchPicker(false)
          }
        }}
        onClose={() => setShowBranchPicker(false)}
      />

      <ConfirmModal
        visible={createdPrUrl !== null}
        title="Pull Request Created"
        message={
          createdPrWarning
            ? `Open it in your browser?\n\n${createdPrWarning}`
            : 'Open it in your browser?'
        }
        confirmLabel="Open"
        onConfirm={() => {
          if (createdPrUrl) {
            openMobilePrUrl(createdPrUrl)
          }
          setCreatedPrUrl(null)
          setCreatedPrWarning(null)
        }}
        onCancel={() => {
          setCreatedPrUrl(null)
          setCreatedPrWarning(null)
        }}
      />
    </>
  )
}
