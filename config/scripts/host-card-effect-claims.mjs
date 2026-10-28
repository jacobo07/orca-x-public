/**
 * G5 scope and G7 wake for check-host-card-claims.mjs (D-08).
 *
 * G5 scope: effect wording (EFFECT_VERB) in the card passes only when the innermost control enclosing
 * it is classified `effect` with an `rpc` that is a host RPC method. A first effect control therefore
 * cannot legitimize wording elsewhere on the card, and an effect control nested inside another control
 * fails.
 *
 * G7 wake: `wake.<suffix>` labels take their suffixes from config.wakeModel (stages, refusal codes and
 * card states). Each names who observed it:
 *   W1 observer   broker, target or phone;
 *   W2 target     only the stages the broker never writes (host-announced, runtime-ready) are target,
 *                 produced by composeWakeProgress with evidence exactly live-response;
 *   W3 wording    no other wake label may read as a woken host (WOKEN_WORDING).
 * Wake labels with no wake vocabulary, or a config without wakeModel, fail rather than pass vacuously.
 *
 * Pure: `literalTestID` and the control tags arrive as parameters, so this module never imports the gate.
 */

export const WOKEN_WORDING = /\b(?:woken|awake|on|up|ready|running|online|booted)\b/i
export const WAKE_TARGET_PRODUCER = 'src/shared/host-wake.ts#composeWakeProgress'
const WAKE_VOCABULARY_NAMES = Object.freeze([
  'HOST_WAKE_STAGES',
  'HOST_WAKE_BROKER_STAGES',
  'HOST_WAKE_REFUSAL_CODES',
  'HOST_WAKE_CARD_STATES'
])
const WAKE_OBSERVERS = Object.freeze(['broker', 'target', 'phone'])

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
  for (const control of controls) {
    const outer = innermostControl(controls, control.start, control)
    if (outer !== null && actionOf(actions, control.testID)?.kind === 'effect') {
      failures.push(
        `${card}:${control.line} effect control "${control.testID}" is nested inside "${outer.testID ?? outer.name}" — an effect control is a sibling of the other controls, never inside one`
      )
    }
  }
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

/** The wake arrays of the model (`export const NAME = [...] as const`) and their card union. */
export function wakeVocabulary(source) {
  const vocab = {}
  for (const name of WAKE_VOCABULARY_NAMES) {
    const match = new RegExp(
      `export\\s+const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]\\s*as\\s+const`
    ).exec(source)
    if (match) {
      // Why: a comment in the list (HOST_WAKE_REFUSAL_CODES has one, with an apostrophe) is no member.
      const members = match[1].replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
      vocab[name] = [...members.matchAll(/(['"])([^'"\n]+)\1/g)].map((item) => item[2])
    }
  }
  const stages = vocab.HOST_WAKE_STAGES
  const codes = vocab.HOST_WAKE_REFUSAL_CODES
  const states = vocab.HOST_WAKE_CARD_STATES
  if (stages && codes && states) {
    vocab.HOST_WAKE_CARD_VOCABULARY = [...stages, ...codes, ...states]
  }
  return vocab
}

function targetSuffixes(vocab) {
  const stages = vocab?.HOST_WAKE_STAGES
  const broker = vocab?.HOST_WAKE_BROKER_STAGES
  // Why empty when unknown: then no label may be target, so a missing model fails closed.
  return Array.isArray(stages) && Array.isArray(broker)
    ? stages.filter((stage) => !broker.includes(stage))
    : []
}

function checkTargetLabel(key, entry, failures) {
  if (entry?.observer !== 'target') {
    failures.push(
      `label "${key}": observer must be target — only the woken host's own answer can say it`
    )
  }
  if (entry?.producer !== WAKE_TARGET_PRODUCER) {
    failures.push(
      `label "${key}": producer must be ${WAKE_TARGET_PRODUCER}, which composes it from the target's answer after packet-sent`
    )
  }
  const evidence = entry?.evidence
  if (!Array.isArray(evidence) || evidence.length !== 1 || evidence[0] !== 'live-response') {
    failures.push(`label "${key}": evidence must be exactly ["live-response"], the target's answer`)
  }
}

function checkWakeLabel({ key, entry, text, targetOnly, failures }) {
  const observer = entry?.observer
  if (!WAKE_OBSERVERS.includes(observer)) {
    failures.push(
      `label "${key}": observer ${JSON.stringify(observer) ?? 'missing'} is not broker, target or phone`
    )
  }
  const isTargetStage = targetOnly.includes(key.slice('wake.'.length))
  if (isTargetStage) {
    checkTargetLabel(key, entry, failures)
  } else if (observer === 'target') {
    failures.push(
      `label "${key}": observer target is only for ${targetOnly.join(', ') || 'the stages the broker never writes'} — a broker or phone observation is not the host's answer`
    )
  }
  if (!(isTargetStage && observer === 'target') && typeof text === 'string') {
    if (WOKEN_WORDING.test(text)) {
      failures.push(
        `label "${key}" reads "${text}" — only the target's own answer may say the host woke`
      )
    }
  }
}

/** W1-W3 over every `wake.` label, classified or rendered; returns how many were judged. */
export function evaluateWakeLabels({ labels, rows, vocab, failures }) {
  const classified = labels ?? {}
  const keys = [...new Set([...Object.keys(classified), ...rows.keys()])].filter((key) =>
    key.startsWith('wake.')
  )
  if (keys.length === 0) {
    return 0
  }
  if (!Array.isArray(vocab?.HOST_WAKE_CARD_VOCABULARY)) {
    failures.push(
      `${keys.length} wake label(s) but no wake vocabulary (HOST_WAKE_CARD_VOCABULARY) — set wakeModel, or every wake rule passes unchecked`
    )
  }
  const targetOnly = targetSuffixes(vocab)
  for (const key of keys) {
    const entry = Object.hasOwn(classified, key) ? classified[key] : undefined
    checkWakeLabel({ key, entry, text: rows.get(key)?.text, targetOnly, failures })
  }
  return keys.length
}

export function checkWakeModel({ config, vocab, failures }) {
  const model = config?.wakeModel
  if (typeof model !== 'string' || model.trim() === '') {
    failures.push(
      'wakeModel is missing from the config — the wake label family would have no vocabulary to be checked against'
    )
    return
  }
  for (const name of WAKE_VOCABULARY_NAMES) {
    if (!Array.isArray(vocab?.[name])) {
      failures.push(`wake vocabulary ${name} not found in ${model}`)
    }
  }
}
