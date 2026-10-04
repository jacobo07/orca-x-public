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
})
