/**
 * G5 scope for check-host-card-claims.mjs: effect wording is judged per control (D-08).
 *
 * Effect wording (EFFECT_VERB) in the card passes only when the innermost control enclosing it is
 * classified `effect` with an `rpc` that is a host RPC method. A first effect control therefore cannot
 * legitimize wording elsewhere on the card, and an effect control nested inside another control fails.
 *
 * Pure: `literalTestID` and the control tags arrive as parameters, so this module never imports the gate.
 */

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

/** Index of the `>` that closes an opening tag whose attributes start at `from`, or -1. */
function openingTagEnd(source, from) {
  let depth = 0
  let quote = null
  for (let i = from; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') {
        i++
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
    } else if (ch === '>' && depth === 0) {
      return i
    }
  }
  return -1
}

/** Index just past the `</Name>` matching an element opened before `from`, same-name openers counted; or null. */
function closingTagEnd(source, name, from) {
  const pattern = new RegExp(`<${name}(?=[\\s/>])|</${name}\\s*>`, 'g')
  pattern.lastIndex = from
  let depth = 1
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    if (match[0].startsWith('</')) {
      if (--depth === 0) {
        return match.index + match[0].length
      }
      continue
    }
    const tagEnd = openingTagEnd(source, match.index + match[0].length)
    if (tagEnd === -1) {
      return null
    }
    if (source[tagEnd - 1] !== '/') {
      depth++
    }
    pattern.lastIndex = tagEnd + 1
  }
  return null
}

/** Every `<Name ...>` element: `start` at `<Name`, `end` just past its matching close or its `/>`. */
export function jsxElements(source, name) {
  const elements = []
  for (const match of source.matchAll(new RegExp(`<${name}(?=[\\s/>])`, 'g'))) {
    const tagEnd = openingTagEnd(source, match.index + match[0].length)
    if (tagEnd === -1) {
      continue
    }
    const selfClosing = source[tagEnd - 1] === '/'
    // Why: an unclosed element covers only its opening tag, so it cannot legitimize anything after it.
    const end = selfClosing ? tagEnd + 1 : (closingTagEnd(source, name, tagEnd + 1) ?? tagEnd + 1)
    elements.push({
      start: match.index,
      end,
      attributes: source.slice(match.index + match[0].length, tagEnd),
      line: lineOf(source, match.index)
    })
  }
  return elements
}

function actionOf(actions, testID) {
  return testID !== null && Object.hasOwn(actions, testID) ? actions[testID] : undefined
}

/** The innermost control strictly enclosing `index`, other than `self`, or null. */
function innermostControl(controls, index, self = null) {
  let found = null
  for (const control of controls) {
    // Why end - 1: JSX text is indexed at the `>` before it, so text just after an element's last `>` is outside.
    const encloses = control.start < index && index < control.end - 1
    if (control !== self && encloses && (found === null || control.start > found.start)) {
      found = control
    }
  }
  return found
}

export function checkEffectWordingScope({
  card,
  cardSource,
  cardCopy,
  actions,
  rpcMethods,
  effectVerb,
  literalTestID,
  controlTags,
  failures
}) {
  const controls = controlTags.flatMap((name) =>
    jsxElements(cardSource, name).map((element) => ({
      ...element,
      name,
      testID: literalTestID(element.attributes)
    }))
  )
  for (const item of cardCopy.filter((entry) => effectVerb.test(entry.text))) {
    const owner = innermostControl(controls, item.index)
    const action = owner === null ? undefined : actionOf(actions, owner.testID)
    if (
      action?.kind !== 'effect' ||
      typeof action.rpc !== 'string' ||
      !rpcMethods.has(action.rpc)
    ) {
      failures.push(
        `${card}:${item.line} effect wording "${item.text}" but no effect control classified to a host RPC method encloses it`
      )
    }
  }
}
