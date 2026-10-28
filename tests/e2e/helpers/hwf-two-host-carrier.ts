import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'

export type HwfCarrier = {
  kill: () => Promise<void>
  restore: () => Promise<void>
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

// Why: the carrier lives in the Playwright worker (real HOME, real `gex44` alias), never inside the isolated-HOME Orca.
export async function startHwfCarrier(
  run: { port: number; carrierHost: string },
  localPort: number
): Promise<HwfCarrier> {
  let child: ChildProcess | null = null
  const start = async (): Promise<void> => {
    child = spawn(
      'ssh',
      [
        '-N',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=5',
        '-o',
        'BatchMode=yes',
        '-L',
        `127.0.0.1:${localPort}:127.0.0.1:${run.port}`,
        run.carrierHost
      ],
      { stdio: 'ignore', windowsHide: true }
    )
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`carrier exited early (code ${child.exitCode}); rung carrier-rebind`)
      }
      if (await canConnect(localPort)) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('carrier did not open the local forward within 20s')
  }
  await start()
  return {
    kill: async () => {
      const current = child
      child = null
      if (current && current.exitCode === null) {
        const exited = new Promise<void>((resolve) => current.once('exit', () => resolve()))
        current.kill()
        await exited
      }
    },
    restore: start
  }
}
