// A tool Orca offers the provider for one turn. Provider-neutral: the driver translates the
// declaration, and the provider's call reaches `invoke`. Whatever authority the tool carries is
// bound into `invoke` by whoever built it, so nothing in the provider's arguments can change it.

export type ProviderTurnToolResult = { success: boolean; text: string }

export type ProviderTurnTool = {
  name: string
  description: string
  /** JSON Schema for the arguments, as the provider will see it. */
  inputSchema: Record<string, unknown>
  invoke: (args: unknown) => Promise<ProviderTurnToolResult>
}
