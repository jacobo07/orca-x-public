// Serves one turn's Orca tools to a provider that takes tools over MCP (Claude). Provider-neutral:
// it exposes exactly the ProviderTurnTool list the turn was given, whose authority is already bound
// into each `invoke` — so this server grants nothing the tool's builder did not. It lives for one
// turn, listens on loopback only, and answers only a caller holding that turn's secret.
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ProviderTurnTool, ProviderTurnToolResult } from './provider-turn-tool'

const MAX_BODY_BYTES = 1024 * 1024
const PROTOCOL_VERSION = '2025-03-26'

export type TurnToolServer = {
  /** Loopback URL, including the turn's secret path. */
  url: string
  /** Sent as `Authorization: Bearer <token>`; the path alone is not enough. */
  token: string
  close: () => Promise<void>
}

type JsonRpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown }

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(null)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => resolve(null))
  })
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end()
    return
  }
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function answer(
  tools: readonly ProviderTurnTool[],
  message: JsonRpcMessage,
  onCall: ((name: string, result: ProviderTurnToolResult) => void) | undefined
): Promise<unknown> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id ?? null, result })
  const fail = (code: number, text: string) => ({ jsonrpc: '2.0', id: message.id ?? null, error: { code, message: text } })
  switch (message.method) {
    case 'initialize': {
      const requested = (message.params as { protocolVersion?: unknown } | null)?.protocolVersion
      return reply({
        protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'orca', version: '1' }
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
      })
    case 'tools/call': {
      const params = message.params as { name?: unknown; arguments?: unknown } | null
      const tool = tools.find((candidate) => candidate.name === params?.name)
      if (!tool) {
        return fail(-32602, `No tool ${String(params?.name)} is offered on this turn.`)
      }
      let result: ProviderTurnToolResult
      try {
        result = await tool.invoke(params?.arguments ?? {})
      } catch (error) {
        result = { success: false, text: error instanceof Error ? error.message : String(error) }
      }
      onCall?.(tool.name, result)
      return reply({ content: [{ type: 'text', text: result.text }], isError: !result.success })
    }
    default:
      return fail(-32601, `Method ${String(message.method)} is not served.`)
  }
}

export async function startTurnToolServer(
  tools: readonly ProviderTurnTool[],
  options: {
    onCall?: (name: string, result: ProviderTurnToolResult) => void
    /** Every request that reached the server, before any check: what a client actually sent. */
    onRequest?: (summary: { method: string | undefined; path: string | undefined }) => void
  } = {}
): Promise<TurnToolServer> {
  const token = randomBytes(24).toString('hex')
  const path = `/mcp/${token}`
  let host = ''
  const server = createServer((request, response) => {
    options.onRequest?.({ method: request.method, path: request.url === path ? '<turn path>' : request.url })
    // Why the Host and Origin checks: a loopback port is reachable from a browser page via DNS
    // rebinding; a real MCP client sends neither a foreign Host nor an Origin.
    if (request.headers.host !== host || request.headers.origin !== undefined) {
      send(response, 403)
      return
    }
    if (request.url !== path) {
      send(response, 404)
      return
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(response, 401)
      return
    }
    if (request.method === 'DELETE') {
      send(response, 200)
      return
    }
    if (request.method !== 'POST') {
      // No server-initiated stream: every answer is the response to its own request.
      send(response, 405)
      return
    }
    void readBody(request).then(async (raw) => {
      if (raw === null) {
        send(response, 413)
        return
      }
      let parsed: JsonRpcMessage | JsonRpcMessage[]
      try {
        parsed = JSON.parse(raw) as JsonRpcMessage | JsonRpcMessage[]
      } catch {
        send(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        return
      }
      const messages = Array.isArray(parsed) ? parsed : [parsed]
      const requests = messages.filter((message) => message.id !== undefined && message.id !== null)
      if (requests.length === 0) {
        // Notifications and responses only: accepted, nothing to answer.
        send(response, 202)
        return
      }
      const answers = await Promise.all(requests.map((message) => answer(tools, message, options.onCall)))
      send(response, 200, Array.isArray(parsed) ? answers : answers[0])
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  host = `127.0.0.1:${port}`
  return {
    url: `http://${host}${path}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

/** The `--mcp-config` value naming only this server, as the `orca` MCP server. */
export function turnToolMcpConfig(server: Pick<TurnToolServer, 'url' | 'token'>): string {
  return JSON.stringify({
    mcpServers: { orca: { type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } } }
  })
}
