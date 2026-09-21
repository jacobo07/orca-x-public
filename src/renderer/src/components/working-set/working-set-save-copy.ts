import { translate } from '@/i18n/i18n'
import type { WorkingSetSaveRequestResult } from '@/lib/project-working-set-save'

/** What a save answered, in the user's words; failure reasons stay distinct. */
export function saveResultText(result: WorkingSetSaveRequestResult): {
  text: string
  ok: boolean
} {
  switch (result.status) {
    case 'saved':
      return result.scrollback.failed.length > 0
        ? {
            ok: true,
            text: translate(
              'workingSet.save.savedWithoutSomeHistory',
              "Snapshot saved; some terminal history couldn't be copied."
            )
          }
        : { ok: true, text: translate('workingSet.save.saved', 'Snapshot saved.') }
    case 'not-capturable':
      return {
        ok: false,
        text:
          result.reason === 'no-terminals'
            ? translate('workingSet.save.noTerminals', 'This workspace has no terminals to save.')
            : translate(
                'workingSet.save.notCapturable',
                "This workspace's terminals couldn't be captured ({{reason}}).",
                { reason: result.reason }
              )
      }
    case 'refused-invalid':
      return {
        ok: false,
        text: translate(
          'workingSet.save.refusedInvalid',
          'The snapshot was rejected as invalid ({{reason}}).',
          { reason: result.reason }
        )
      }
    case 'refused-unsupported-version':
      return {
        ok: false,
        text: translate(
          'workingSet.save.unsupportedVersion',
          "This build can't write that snapshot version."
        )
      }
    case 'identity-collision':
      return {
        ok: false,
        text: translate(
          'workingSet.save.identityCollision',
          'A snapshot with this id already exists. Try again.'
        )
      }
    case 'write-failed':
    case 'durability-failed':
    case 'publish-failed':
      return {
        ok: false,
        text: translate(
          'workingSet.save.writeFailed',
          "The snapshot couldn't be written ({{code}}).",
          {
            code: result.code ?? result.status
          }
        )
      }
    case 'read-back-failed':
      return {
        ok: false,
        text: translate(
          'workingSet.save.readBackFailed',
          "Saved, but it couldn't be confirmed. It may appear after refreshing."
        )
      }
    case 'verify-failed':
      return {
        ok: false,
        text: translate(
          'workingSet.save.verifyFailed',
          "The saved snapshot didn't match what was sent and was set aside."
        )
      }
    case 'unavailable':
      return {
        ok: false,
        text: translate(
          'workingSet.history.unavailable',
          "Snapshots aren't available in this client."
        )
      }
  }
}
