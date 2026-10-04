// Minimal vitest config for an era run: the era tree is the root and owns the Vite cache, so a
// run never writes into the shared node_modules. Nothing from the current repo is aliased.
const eraTree = process.env.ERA_TREE

export default {
  root: eraTree,
  cacheDir: `${eraTree}/.era-vite-cache`,
  define: { ORCA_FEATURE_WALL_ENABLED: 'true' },
  test: {
    environment: 'node',
    include: ['era-session-writer.test.ts'],
    execArgv: ['--no-experimental-webstorage'],
    hookTimeout: 60_000,
    testTimeout: 60_000
  }
}
