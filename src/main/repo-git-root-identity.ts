import {
  classifyGitRootProbe,
  GIT_ROOT_PROBE_ARGV,
  nextGitRootProbeStep,
  type GitRootProbeResult,
  type GitRootProbeStep,
  type GitRootProbeSteps
} from '../shared/git-root-identity'
import { gitExecFileAsync } from './git/runner'
import { getSshGitProvider } from './providers/ssh-git-dispatch'

async function runProbeStep(
  args: readonly string[],
  repoPath: string,
  connectionId?: string | null
): Promise<GitRootProbeStep> {
  try {
    const argv = [...args]
    const result = connectionId
      ? await getSshGitProvider(connectionId)?.exec(argv, repoPath)
      : await gitExecFileAsync(argv, { cwd: repoPath })
    return result ? { ok: true, stdout: result.stdout } : { ok: false }
  } catch {
    // Both seams throw on a non-zero git exit; the classifier decides what that means.
    return { ok: false }
  }
}

/** `settled-none` means git answered and the repo has no usable root; `unavailable`
 *  means git was not reached or did not answer, and says nothing about the repo. */
export async function probeGitRootIdentity(
  repoPath: string,
  connectionId?: string | null
): Promise<GitRootProbeResult> {
  const steps: GitRootProbeSteps = {}
  for (let next = nextGitRootProbeStep(steps); next; next = nextGitRootProbeStep(steps)) {
    steps[next] = await runProbeStep(GIT_ROOT_PROBE_ARGV[next], repoPath, connectionId)
  }
  return classifyGitRootProbe(steps, repoPath)
}
