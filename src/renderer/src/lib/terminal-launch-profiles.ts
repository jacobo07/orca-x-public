/**
 * The launch-profile authority moved to `src/shared` once mobile needed to ask the same question.
 * This re-export keeps the renderer's `@/lib` import surface stable; there is no second copy of the
 * composition rules, which is the whole point of moving it.
 */
export {
  agentProfileId,
  buildTerminalLaunchProfiles,
  findTerminalLaunchProfile,
  HOST_DEFAULT_SHELL_PROFILE_ID,
  userProfileId,
  type TerminalLaunchProfile,
  type TerminalLaunchProfileSet
} from '../../../shared/terminal-launch-profiles'
