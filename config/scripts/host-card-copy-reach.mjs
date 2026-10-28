/**
 * G8 copy reach for check-host-card-claims.mjs (21-REVIEW WR-04).
 *
 * The wording laws must hold for every file that can render card copy, not only the label table
 * (W3) and the card file (G5 scope). The reach is the card, the presenter, and every module either
 * reaches through relative imports that resolve inside the card's own directory, transitively.
 * Over each module's string literals and JSX text (the presenter's HOST_CARD_LABELS block excluded,
 * since W3 and G1-G4 judge those rows):
 *   woken   no copy may read as a woken host (WOKEN_WORDING) — only the target's own answer, through
 *           a classified target label, may say it;
 *   effect  in a component (.tsx) other than the card, effect wording passes only inside a control
 *           classified effect with a host RPC (the G5 scope rule); in a non-JSX module it fails.
 * A literal is matched with separators read as spaces, so `host-woken` is copy like `Host woken`;
 * effect phrases are removed before the woken test, so a backed "Power on" button is G5's alone. In a
 * .ts module only string literals are copy (a `>`...`<` span there is generics, not JSX text).
 * A literal that equals a HOST_CARD_LABELS key, a model or wakeModel vocabulary member, or one of the
 * module's own import specifiers is a machine token and is not copy.
 *
 * Pure: the gate passes its own comment stripping, copy extraction and control helpers in.
 */

import path from 'node:path'

import { importsOf, resolveSpecifier } from './check-workspace-surface-claims.mjs'
import { checkEffectWordingScope, WOKEN_WORDING } from './host-card-effect-claims.mjs'

const SEPARATORS = /[._/:\\-]+/g
const SUBSTITUTION = /\$\{[^}]*\}/g
const TEST_MODULE = /\.(test|spec)\.tsx?$/
const QUOTES = new Set(["'", '"', '`'])

function spoken(text) {
  return text.replace(SUBSTITUTION, ' ').replace(SEPARATORS, ' ')
}

/** The card, the presenter and every module they reach by relative imports inside the card's directory. */
export function cardCopyModules({ card, presenter, read, exists }) {
  const root = `${path.posix.dirname(card)}/`
  const modules = [card, presenter]
  for (let i = 0; i < modules.length; i++) {
    const source = read(modules[i])
    for (const { specifier } of source === null ? [] : importsOf(source)) {
      const resolved = resolveSpecifier(modules[i], specifier, exists)
      if (
        resolved !== null &&
        resolved.startsWith(root) &&
        !TEST_MODULE.test(resolved) &&
        !modules.includes(resolved)
      ) {
        modules.push(resolved)
      }
    }
  }
  return modules
}

function machineTokens(source, labelKeys, vocab) {
  const tokens = new Set(labelKeys)
  for (const members of Object.values(vocab ?? {})) {
    for (const member of Array.isArray(members) ? members : []) {
      tokens.add(member)
    }
  }
  for (const { specifier } of importsOf(source)) {
    tokens.add(specifier)
  }
  return tokens
}

/** W3 and G5 over the whole reach; returns how many modules were scanned. */
export function checkCardCopyReach({
  card,
  presenter,
  read,
  exists,
  labelKeys,
  vocab,
  copyOf,
  actions,
  rpcMethods,
  effectVerb,
  literalTestID,
  controlTags,
  failures
}) {
  const modules = cardCopyModules({ card, presenter, read, exists })
  const saysEffect = { test: (text) => effectVerb.test(spoken(text)) }
  const effectPhrase = new RegExp(effectVerb.source, 'gi')
  // Why remove effect phrases first: "Power on" offers an action (G5 owns it), it does not say the host is on.
  const saysWoken = (text) => WOKEN_WORDING.test(spoken(text).replace(effectPhrase, ' '))
  for (const file of modules) {
    const source = read(file)
    if (source === null) {
      continue
    }
    const tokens = machineTokens(source, labelKeys, vocab)
    const { stripped, copy } = copyOf(file, source)
    const jsx = file.endsWith('.tsx')
    // Why literals only outside .tsx: a `>` ... `<` span in a .ts module is generics or comparisons, never JSX text.
    const said = copy.filter(
      (item) => !tokens.has(item.text) && (jsx || QUOTES.has(stripped[item.index]))
    )
    for (const item of said.filter((entry) => saysWoken(entry.text))) {
      failures.push(
        `${file}:${item.line} copy "${item.text}" reads as a woken host outside HOST_CARD_LABELS — only the target's own answer may say it`
      )
    }
    // Why skip the card: G5 scope already judges its effect wording, control by control.
    if (file === card) {
      continue
    }
    if (file.endsWith('.tsx')) {
      checkEffectWordingScope({
        card: file,
        cardSource: stripped,
        cardCopy: said,
        actions,
        rpcMethods,
        effectVerb: saysEffect,
        literalTestID,
        controlTags,
        failures
      })
      continue
    }
    for (const item of said.filter((entry) => saysEffect.test(entry.text))) {
      failures.push(
        `${file}:${item.line} effect wording "${item.text}" outside HOST_CARD_LABELS — only a backed effect control in the card may offer it`
      )
    }
  }
  return modules.length
}
