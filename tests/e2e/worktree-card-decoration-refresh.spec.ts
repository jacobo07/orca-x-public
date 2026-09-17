import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test as base, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// A fake `gh` answers from a state file this test rewrites, so a PR or issue changing on the
// provider reaches the cards only through the shared per-window decoration refresh.

const fakeGhDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-card-gh-'))
const statePath = path.join(fakeGhDir, 'state.json')
const logPath = path.join(fakeGhDir, 'calls.log')
const BRANCHES = ['card-branch-0', 'card-branch-1']
const PR_NUMBERS = [41, 42]
const ISSUE_NUMBERS = [7, 8]

type ProviderState = { prTitle: string; issueTitle: string }

function writeProviderState(state: ProviderState): void {
  writeFileSync(statePath, JSON.stringify(state))
}

const fakeGhBody = `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
const joined = args.join(' ')
fs.appendFileSync(${JSON.stringify(logPath)}, Date.now() + ' ' + joined.slice(0, 80) + '\\n')
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'))
const branches = ${JSON.stringify(BRANCHES)}
const prs = ${JSON.stringify(PR_NUMBERS)}
const out = (value) => { console.log(JSON.stringify(value)); process.exit(0) }
if (args[0] === 'auth' && args[1] === 'status') {
  console.error('github.com\\n  ✓ Logged in to github.com account e2e (GITHUB_TOKEN)')
  process.exit(0)
}
if (args[0] === '--version') { console.log('gh version 2.60.0 (2026-01-01)'); process.exit(0) }
if (args[0] === 'api' && args.includes('user')) { console.log('e2e'); process.exit(0) }
if (args[0] === 'api' && joined.includes('rate_limit')) {
  out({ resources: { core: { limit: 5000, remaining: 5000, reset: 0 }, graphql: { limit: 5000, remaining: 5000, reset: 0 }, search: { limit: 30, remaining: 30, reset: 0 } } })
}
const title = (n) => state.prTitle + ' #' + n
const branchOf = (n) => branches[prs.indexOf(n)]
const issueMatch = joined.match(/repos\\/acme\\/repo\\/issues\\/(\\d+)(\\s|$)/)
if (args[0] === 'api' && issueMatch) {
  const n = Number(issueMatch[1])
  out({ number: n, title: state.issueTitle + ' #' + n, state: 'open', html_url: 'https://github.com/acme/repo/issues/' + n, labels: [], body: '' })
}
const pullMatch = joined.match(/repos\\/acme\\/repo\\/pulls\\/(\\d+)(\\s|$)/)
if (args[0] === 'api' && pullMatch && prs.includes(Number(pullMatch[1]))) {
  const n = Number(pullMatch[1])
  out({ number: n, title: title(n), state: 'open', draft: false, merged_at: null, html_url: 'https://github.com/acme/repo/pull/' + n, updated_at: '2026-09-17T00:00:00Z', mergeable: true, labels: [], user: { login: 'e2e' }, head: { ref: branchOf(n), sha: 'unknown', repo: { name: 'repo', owner: { login: 'acme' } } }, base: { ref: 'master' } })
}
if (args[0] === 'pr' && args[1] === 'view' && prs.includes(Number(args[2]))) {
  const n = Number(args[2])
  out({ number: n, title: title(n), state: 'OPEN', url: 'https://github.com/acme/repo/pull/' + n, labels: [], updatedAt: '2026-09-17T00:00:00Z', author: { login: 'e2e' }, isDraft: false, headRefName: branchOf(n), baseRefName: 'master', headRefOid: 'unknown', headRepositoryOwner: { login: 'acme' }, additions: 0, deletions: 0, changedFiles: 0, reviewDecision: '', reviewRequests: [], latestReviews: [], assignees: [], statusCheckRollup: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMergeRequest: null, maintainerCanModify: false })
}
console.error('no pull requests found')
process.exit(1)
`

// Why: Node's execFile on Windows resolves only .com/.exe on PATH, so a gh.cmd shim is never run
// and the real gh answers instead. Compile a tiny gh.exe that forwards to the script.
const shimSource = String.raw`using System; using System.Diagnostics; using System.Linq; using System.Text;
class GhShim {
  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    int slashes = 0;
    foreach (var c in a) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); }
      else { sb.Append('\\', slashes); sb.Append(c); }
      slashes = 0;
    }
    sb.Append('\\', slashes * 2);
    sb.Append('"');
    return sb.ToString();
  }
  static int Main(string[] args) {
    var info = new ProcessStartInfo(${JSON.stringify(process.execPath)},
      Quote(${JSON.stringify(path.join(fakeGhDir, 'fake-gh.js'))}) + " " + string.Join(" ", args.Select(Quote)));
    info.UseShellExecute = false;
    var child = Process.Start(info);
    child.WaitForExit();
    return child.ExitCode;
  }
}`

const fakeGhPath = path.join(fakeGhDir, process.platform === 'win32' ? 'gh.exe' : 'gh')
if (process.platform === 'win32') {
  writeFileSync(path.join(fakeGhDir, 'fake-gh.js'), fakeGhBody)
  const shimPath = path.join(fakeGhDir, 'gh-shim.cs')
  writeFileSync(shimPath, shimSource)
  execFileSync(
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    ['/nologo', '/target:exe', `/out:${fakeGhPath}`, shimPath],
    { stdio: 'pipe' }
  )
} else {
  writeFileSync(fakeGhPath, fakeGhBody)
  chmodSync(fakeGhPath, 0o755)
}

const test = base.extend({
  launchEnv: [{ PATH: `${fakeGhDir}${path.delimiter}${process.env.PATH ?? ''}` }, { option: true }]
})

test.afterAll(() => {
  rmSync(fakeGhDir, { recursive: true, force: true })
})

type RefreshSnapshot = {
  clockRunning: boolean
  ticks: number
  subjects: Record<'hosted-review' | 'linked-issue', number>
  holders: number
}

// Why: the hook installs with the first card registration, so absence means no card registered yet.
async function readRefresh(page: Page): Promise<RefreshSnapshot | null> {
  return page.evaluate(() => {
    const read = (window as { __orcaWorktreeCardDecorationRefresh?: () => RefreshSnapshot })
      .__orcaWorktreeCardDecorationRefresh
    return read ? read() : null
  })
}

// Why: the default card renders "#n" labels, not titles; the titles live in the entries the cards
// read, which nothing but the shared refresh fills in this test.
async function cachedTitle(
  page: Page,
  cache: 'issueCache' | 'hostedReviewCache',
  keySuffix: string
): Promise<string | null> {
  return page.evaluate(
    ({ cache, keySuffix }) => {
      const entries = window.__store!.getState()[cache] as Record<
        string,
        { data: { title?: string } | null }
      >
      const key = Object.keys(entries).find((k) => k.endsWith(keySuffix))
      return key ? (entries[key].data?.title ?? null) : null
    },
    { cache, keySuffix }
  )
}

async function rowText(page: Page, worktreeId: string): Promise<string> {
  return page.evaluate(
    (id) =>
      document.querySelector(`[data-worktree-row-key][data-worktree-id="${CSS.escape(id)}"]`)
        ?.textContent ?? '',
    worktreeId
  )
}

function ghCalls(): string[] {
  return existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n') : []
}

test('worktree card decorations follow provider changes through one clock per window', async ({
  orcaPage,
  testRepoPath
}) => {
  // Why: the issue family refreshes every 5 min, so observing a real change takes that long.
  test.setTimeout(12 * 60_000)
  writeProviderState({ prTitle: 'PR before', issueTitle: 'Issue before' })
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/repo.git'], {
    cwd: testRepoPath,
    stdio: 'pipe'
  })
  await waitForSessionReady(orcaPage)

  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-card-refresh-')))
  const dirs = BRANCHES.map((_, i) => path.join(parent, `card-${i}`))
  try {
    for (const [i, dir] of dirs.entries()) {
      execFileSync('git', ['worktree', 'add', '-b', BRANCHES[i], dir, 'HEAD'], {
        cwd: testRepoPath,
        stdio: 'pipe'
      })
    }
    const readIds = (): Promise<string[]> =>
      orcaPage.evaluate(
        (wanted) => {
          const norm = (v: string): string => v.replaceAll('\\', '/').toLowerCase()
          const all = Object.values(window.__store!.getState().worktreesByRepo).flat()
          return wanted.map((d) => all.find((w) => norm(w.path) === norm(d))?.id ?? '')
        },
        dirs.map((d) => realpathSync(d))
      )
    await expect
      .poll(async () => (await readIds()).every(Boolean), {
        timeout: 30_000,
        message: 'HARNESS-FAILED: linked worktrees never reached the store'
      })
      .toBe(true)
    const ids = await readIds()

    await orcaPage.evaluate(
      ({ ids, issues, prs }) => {
        const state = window.__store!.getState()
        state.setWorktreeCardProperties(['status', 'pr', 'issue'])
        ids.forEach((id, i) =>
          state.updateWorktreeMeta(id, { linkedIssue: issues[i], linkedPR: prs[i] })
        )
      },
      { ids, issues: ISSUE_NUMBERS, prs: PR_NUMBERS }
    )
    await orcaPage.locator('[data-left-nav-switch="projects"]').click()

    for (const [i, id] of ids.entries()) {
      // The rendered card carries both links, so these rows are the ones registering.
      await expect
        .poll(() => rowText(orcaPage, id), { timeout: 30_000 })
        .toContain(`#${ISSUE_NUMBERS[i]}`)
      await expect
        .poll(() => cachedTitle(orcaPage, 'hostedReviewCache', `::${BRANCHES[i]}`), {
          timeout: 60_000
        })
        .toBe(`PR before #${PR_NUMBERS[i]}`)
      await expect
        .poll(() => cachedTitle(orcaPage, 'issueCache', `::${ISSUE_NUMBERS[i]}`), {
          timeout: 60_000
        })
        .toBe(`Issue before #${ISSUE_NUMBERS[i]}`)
    }

    // One clock serves every card: each linked issue is one subject however many cards mount.
    const before = await readRefresh(orcaPage)
    expect(before).toMatchObject({ clockRunning: true })
    expect(before!.subjects['linked-issue']).toBe(ISSUE_NUMBERS.length)
    expect(before!.subjects['hosted-review']).toBeGreaterThanOrEqual(PR_NUMBERS.length)
    const changedAt = Date.now()

    writeProviderState({ prTitle: 'PR after', issueTitle: 'Issue after' })
    for (const [i] of ids.entries()) {
      await expect
        .poll(() => cachedTitle(orcaPage, 'hostedReviewCache', `::${BRANCHES[i]}`), {
          timeout: 4 * 60_000,
          intervals: [5_000],
          message: 'a PR change on the provider never reached the card'
        })
        .toBe(`PR after #${PR_NUMBERS[i]}`)
    }
    const prSeenAfterMs = Date.now() - changedAt
    for (const [i] of ids.entries()) {
      await expect
        .poll(() => cachedTitle(orcaPage, 'issueCache', `::${ISSUE_NUMBERS[i]}`), {
          timeout: 8 * 60_000,
          intervals: [10_000],
          message: 'an issue change on the provider never reached the card'
        })
        .toBe(`Issue after #${ISSUE_NUMBERS[i]}`)
    }
    const issueSeenAfterMs = Date.now() - changedAt

    const after = await readRefresh(orcaPage)
    expect(after).toMatchObject({ clockRunning: true })
    test.info().annotations.push({
      type: 'observation',
      description: JSON.stringify({ before, after, prSeenAfterMs, issueSeenAfterMs })
    })
  } finally {
    const caches = await orcaPage
      .evaluate(() => {
        const state = window.__store!.getState()
        return {
          issues: Object.entries(state.issueCache).map(([k, v]) => [k.slice(-40), v.data?.title]),
          reviews: Object.entries(state.hostedReviewCache).map(([k, v]) => [
            k.slice(-40),
            v.data?.title
          ])
        }
      })
      .catch((error) => String(error))
    test.info().annotations.push({
      type: 'final',
      description: JSON.stringify({ refresh: await readRefresh(orcaPage).catch(String), caches })
    })
    test.info().annotations.push({ type: 'gh-calls', description: ghCalls().join('\n') })
    for (const dir of dirs) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', dir], {
          cwd: testRepoPath,
          stdio: 'pipe'
        })
      } catch {
        // Why: the worktree may already be gone; the temp parent is removed below either way.
      }
    }
    rmSync(parent, { recursive: true, force: true })
  }
})
