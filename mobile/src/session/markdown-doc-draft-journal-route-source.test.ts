import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const route = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)
// A commented-out call is not a call.
const code = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// The session route is too large to render in a unit test, so the wiring is pinned
// on source, the same way the tasks route boundary is. The hook is proven on its own;
// this fails if the route stops calling it or feeds it the wrong inputs.
describe('session route markdown draft journal wiring', () => {
  it('imports the markdown doc draft journal hook', () => {
    expect(code).toMatch(
      /import \{ useMobileMarkdownDocDraftJournal \} from '[./]*src\/session\/use-mobile-markdown-doc-draft-journal'/
    )
  })

  it('calls it for the active markdown tab, its doc state, and restores through the editor update', () => {
    const call = code.match(/useMobileMarkdownDocDraftJournal\(\{([\s\S]*?)\n {2}\}\)/)
    expect(call, 'the route must call useMobileMarkdownDocDraftJournal').not.toBeNull()
    const args = call![1]
    expect(args).toMatch(/\bhostId,/)
    expect(args).toMatch(/\bworktreeId,/)
    expect(args).toMatch(/tab: activeMarkdownTab,/)
    expect(args).toMatch(/markdownDocs\.get\(activeMarkdownTab\.id\)/)
    expect(args).toMatch(/onRestore: updateMarkdownLocalContent\b/)
  })
  // Why source pins: each of these routes drops the phone draft without an unmount, so the journal entry must
  // be retired by an explicit call, and the call must come before the read that replaces the doc.
  function bodyOf(declaration: RegExp): string {
    const match = code.match(declaration)
    expect(match, `the route must declare ${declaration}`).not.toBeNull()
    return match![1]
  }

  it('retires the journal entry before Discard Changes re-reads the doc', () => {
    const body = bodyOf(
      /const confirmDiscardMarkdown = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[/
    )
    const discardAt = body.indexOf('discardMarkdownDraft(target)')
    const readAt = body.indexOf('readMarkdownTab(target)')
    expect(discardAt).toBeGreaterThanOrEqual(0)
    expect(readAt).toBeGreaterThan(discardAt)
  })

  it('retires the journal entry when a dirty doc is refreshed, and wires Refresh through it', () => {
    const body = bodyOf(/const refreshMarkdownTab = useCallback\(([\s\S]*?)\n {2}\)\n/)
    expect(body).toMatch(/doc\?\.status === 'ready' && doc\.isDirty/)
    expect(body.indexOf('discardMarkdownDraft(tab)')).toBeGreaterThanOrEqual(0)
    expect(code).toMatch(/onRefresh=\{\(\) => refreshMarkdownTab\(activeMarkdownTab\)\}/)
  })

  it('retires every dirty draft before Discard & Leave leaves the session', () => {
    const action = code.match(
      /label: 'Discard & Leave',[\s\S]*?onPress: \(\) => \{([\s\S]*?)\n {12}\}/
    )
    expect(action, 'the Discard & Leave action must exist').not.toBeNull()
    const discardAt = action![1].indexOf('discardLeaveDrafts(leaveDrafts ?? [])')
    expect(discardAt).toBeGreaterThanOrEqual(0)
    expect(action![1].indexOf('leaveSession()')).toBeGreaterThan(discardAt)
  })
})
