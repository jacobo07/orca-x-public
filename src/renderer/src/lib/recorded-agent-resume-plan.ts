import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import type { AgentResumeLaunchTarget } from '@/lib/agent-resume-launch-target'
import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import type { TuiAgent } from '../../../shared/tui-agent'

export type RecordedAgentResumeSettings = {
  agentCmdOverrides?: Partial<Record<TuiAgent, string>>
  agentDefaultArgs?: Partial<Record<TuiAgent, string>>
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>>
}

export type RecordedAgentResumePlan = NonNullable<ReturnType<typeof buildAgentResumeStartupPlan>>

/**
 * The one way Orca turns a pane's retained provider session into a resume launch.
 *
 * Why the recorded config wins: the session was started with those args and env
 * (an account home, a profile), so today's defaults could resume it as someone else.
 * Defaults apply only when nothing was recorded.
 */
export function planRecordedAgentResume(args: {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  launchConfig: SleepingAgentLaunchConfig | undefined
  settings: RecordedAgentResumeSettings | null | undefined
  target: AgentResumeLaunchTarget
}): RecordedAgentResumePlan | null {
  const { agent, launchConfig, settings } = args
  return buildAgentResumeStartupPlan({
    agent,
    providerSession: args.providerSession,
    cmdOverrides: settings?.agentCmdOverrides ?? {},
    agentArgs:
      launchConfig !== undefined
        ? launchConfig.agentArgs
        : resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs),
    agentEnv:
      launchConfig !== undefined
        ? launchConfig.agentEnv
        : resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv),
    ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    ...(launchConfig?.ompResumeFilePath
      ? { ompResumeFilePath: launchConfig.ompResumeFilePath }
      : {}),
    platform: args.target.platform,
    shell: args.target.shell
  })
}
