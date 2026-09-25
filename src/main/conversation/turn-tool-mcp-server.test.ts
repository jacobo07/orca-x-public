import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderTurnTool } from './provider-turn-tool'
import { startTurnToolServer, turnToolMcpConfig, type TurnToolServer } from './turn-tool-mcp-server'

const echo: ProviderTurnTool = {
  name: 'orca_delegate',
  description: 'delegate',
  inputSchema: { type: 'object' },
  invoke: async (args) => ({ success: true, text: `got ${JSON.stringify(args)}` })
}

let server: TurnToolServer | null = null

afterEach(async () => {
  await server?.close()
  server = null
})

/** Raw request so Host and Origin can be set exactly as an attacker would. */
function raw(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; body: string }> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: target.hostname, port: target.port, path: target.pathname, method: options.method ?? 'POST', headers: options.headers },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

const call = (s: TurnToolServer, body: unknown, headers: Record<string, string> = {}) =>
  raw(s.url, {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}`, ...headers },
    body: JSON.stringify(body)
  })

describe('the turn tool MCP server', () => {
  it('speaks enough MCP for a client to initialize, list and call the turn’s tools', async () => {
    server = await startTurnToolServer([echo])

    const init = JSON.parse((await call(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).body)
    const accepted = await call(server, { jsonrpc: '2.0', method: 'notifications/initialized' })
    const listed = JSON.parse((await call(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body)
    const called = JSON.parse(
      (await call(server, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'orca_delegate', arguments: { agent: 'a' } } })).body
    )

    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } })
    expect(accepted.status).toBe(202)
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['orca_delegate'])
    expect(called.result).toEqual({ content: [{ type: 'text', text: 'got {"agent":"a"}' }], isError: false })
  })

  it('serves only the tools of this turn', async () => {
    server = await startTurnToolServer([echo])

    const called = JSON.parse(
      (await call(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orchestration.gateResolve', arguments: {} } })).body
    )

    expect(called.error).toMatchObject({ code: -32602 })
  })

  it('answers no one without the turn’s secret, and nothing a browser page could send', async () => {
    server = await startTurnToolServer([echo])
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

    expect((await call(server, body, { authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await raw(server.url.replace(/\/mcp\/.+$/, '/mcp/guess'), { body: '{}' })).status).toBe(404)
    expect((await call(server, body, { origin: 'http://evil.example' })).status).toBe(403)
    expect((await call(server, body, { host: 'evil.example' })).status).toBe(403)
    expect(new URL(server.url).hostname).toBe('127.0.0.1')
  })

  it('stops answering when the turn ends', async () => {
    const closing = await startTurnToolServer([echo])
    const url = closing.url

    await closing.close()

    await expect(raw(url, { body: '{}' })).rejects.toThrow()
  })

  it('names itself `orca` in the config handed to the provider, with the secret as a header', async () => {
    server = await startTurnToolServer([echo])

    expect(JSON.parse(turnToolMcpConfig(server))).toEqual({
      mcpServers: { orca: { type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } } }
    })
  })
})
