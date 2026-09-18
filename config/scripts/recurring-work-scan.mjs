// Structural sweep for recurring work in production source (Resource Elasticity R4).
// Text-based on purpose: the repo has no declared JS/TS parser dependency. Known blind spots are
// listed in docs/reference/resource-elasticity-fabric.md (R4).
import fs from 'node:fs/promises'
import path from 'node:path'

export const SCAN_ROOTS = ['src']
const SOURCE_EXT = /\.(ts|tsx|mts|js|mjs)$/
const EXCLUDED = [
  /(^|\/)node_modules\//,
  /(^|\/)__fixtures__\//,
  /(^|\/)__mocks__\//,
  /\.(test|spec|bench)\.[cm]?[jt]sx?$/,
  /\.d\.ts$/,
  /test-harness/,
  /test-utils?\./,
  /-test-environment\./,
  /-fixtures?\./,
  /(^|\/)e2e-/
]

export function isScannedPath(relPath) {
  return SOURCE_EXT.test(relPath) && !EXCLUDED.some((pattern) => pattern.test(relPath))
}

const REGEX_PREFIX = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^'
])

// Blanks comments, string/template text and regex literals so braces and call names in them
// cannot be mistaken for code. Template `${}` expressions stay, since they are code.
export function stripNonCode(source) {
  const out = source.split('')
  const blank = (from, to) => {
    for (let i = from; i < to; i++) {
      if (out[i] !== '\n') {
        out[i] = ' '
      }
    }
  }
  const templateDepth = []
  let braceDepth = 0
  let lastSignificant = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      blank(i, stop)
      i = stop
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < source.length && source[j] !== ch && source[j] !== '\n') {
        j += source[j] === '\\' ? 2 : 1
      }
      blank(i + 1, j)
      i = j + 1
      lastSignificant = 'str'
      continue
    }
    if (ch === '`' || (ch === '}' && templateDepth.at(-1) === braceDepth)) {
      if (ch === '}') {
        templateDepth.pop()
      }
      let j = i + 1
      while (j < source.length && source[j] !== '`') {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === '$' && source[j + 1] === '{') {
          break
        }
        j += 1
      }
      blank(i + 1, j)
      if (source[j] === '$') {
        templateDepth.push(braceDepth)
        i = j + 2
        lastSignificant = '{'
      } else {
        i = j + 1
        lastSignificant = 'str'
      }
      continue
    }
    if (
      ch === '/' &&
      (REGEX_PREFIX.has(lastSignificant) ||
        lastSignificant === '' ||
        /\b(return|typeof|case)$/.test(source.slice(Math.max(0, i - 8), i).trimEnd()))
    ) {
      let j = i + 1
      let inClass = false
      while (j < source.length && source[j] !== '\n') {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === '[') {
          inClass = true
        } else if (source[j] === ']') {
          inClass = false
        } else if (source[j] === '/' && !inClass) {
          break
        }
        j += 1
      }
      if (source[j] === '/') {
        blank(i + 1, j)
        i = j + 1
        lastSignificant = 'regex'
        continue
      }
    }
    if (ch === '{') {
      braceDepth += 1
    } else if (ch === '}') {
      braceDepth -= 1
    }
    if (!/\s/.test(ch)) {
      lastSignificant = /[\w$)\]]/.test(ch) ? 'word' : ch
    }
    i += 1
  }
  return out.join('')
}

const NAME = '[A-Za-z_$][\\w$]*'
const HEADER_NAME_PATTERNS = [
  new RegExp(`\\bclass\\s+(${NAME})`),
  new RegExp(`\\bfunction\\s*\\*?\\s*(${NAME})\\s*(?:<[^>]*>)?\\s*\\(`),
  new RegExp(
    `\\b(?:const|let|var)\\s+(${NAME})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\(|${NAME}\\s*=>)`
  ),
  new RegExp(
    `^(?:(?:public|private|protected|static|async|override|get|set)\\s+)*(${NAME})\\s*(?:<[^>]*>)?\\s*\\([^;{}]*\\)\\s*(?::[^;{}]+)?$`
  ),
  new RegExp(
    `(?:^|[\\s,{])(${NAME})\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|${NAME}\\s*=>)`
  )
]
const NOT_A_NAME = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'constructor',
  'else',
  'try',
  'do',
  'async',
  'await',
  'new',
  'then',
  'finally',
  'forEach',
  'map',
  'filter',
  'some',
  'every',
  'useEffect',
  'useLayoutEffect',
  'useCallback',
  'useMemo',
  'useState',
  'useRef',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'Promise'
])

// Every `{...}` block with the declaration name that precedes it, when it has one.
export function collectScopes(code) {
  const scopes = []
  const stack = []
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '{') {
      stack.push(i)
    } else if (code[i] === '}' && stack.length > 0) {
      const open = stack.pop()
      scopes.push({ open, close: i, name: scopeName(code, open) })
    }
  }
  return scopes.sort((a, b) => a.open - b.open)
}

// Walks back from a `{` over balanced parens/brackets to the statement start. Leaving an
// enclosing call (`const x = useCallback((e) => {`) names the scope after that binding.
function scopeName(code, open) {
  let depth = 0
  let j = open - 1
  for (; j >= 0; j--) {
    const ch = code[j]
    if (ch === ')' || ch === ']') {
      depth += 1
    } else if (ch === '(' || ch === '[') {
      depth -= 1
      if (depth < 0) {
        break
      }
    } else if (depth === 0 && (ch === ';' || ch === '{' || ch === '}' || ch === '\n')) {
      // A newline ends the header unless the line above continues it (no-semicolon style).
      if (ch !== '\n' || !/[=,(:?&|]\s*$|=>\s*$/.test(code.slice(Math.max(0, j - 3), j))) {
        break
      }
    }
  }
  const header = code
    .slice(j + 1, open)
    .replace(/\s+/g, ' ')
    .trim()
  const own = headerName(header)
  if (own || depth >= 0 || !/^(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(header)) {
    return own
  }
  const lineStart = code.lastIndexOf('\n', j) + 1
  const binding = new RegExp(
    `\\b(?:const|let|var)\\s+(${NAME})\\s*(?::[^=]+)?=\\s*[\\w$.]+\\s*(?:<[^>]*>)?\\s*$`
  ).exec(code.slice(lineStart, j))
  return binding ? binding[1] : null
}

function headerName(header) {
  for (const pattern of HEADER_NAME_PATTERNS) {
    const match = pattern.exec(header)
    if (match && !NOT_A_NAME.has(match[1])) {
      return match[1]
    }
  }
  return null
}

function enclosingNames(scopes, index) {
  return scopes.filter((s) => s.open < index && s.close > index && s.name).map((s) => s.name)
}

// Text of a call's argument list starting at the `(` after `index`.
export function callArguments(code, index) {
  const open = code.indexOf('(', index)
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') {
      depth += 1
    } else if (code[i] === ')') {
      depth -= 1
      if (depth === 0) {
        return code.slice(open + 1, i)
      }
    }
  }
  return code.slice(open + 1)
}

const CALLEE = new RegExp(`(?:^|[^\\w$.])(?:this\\.)?(${NAME})\\s*\\(`, 'g')
function calleesOf(text) {
  return new Set([...text.matchAll(CALLEE)].map((m) => m[1]))
}

const SPAWN_CALL =
  /(?:^|[^\w$])(?:execFile|execFileAsync|execFileSync|execSync|spawn|spawnSync|fork|forkIpcChild|runCommand)\s*\(|\bexec\s*\(/

function bodiesByName(scopes, code) {
  const bodies = new Map()
  for (const scope of scopes) {
    if (scope.name) {
      bodies.set(scope.name, (bodies.get(scope.name) ?? '') + code.slice(scope.open, scope.close))
    }
  }
  return bodies
}

const TIMER_PATTERNS = [
  { kind: 'interval', pattern: /(?:^|[^\w$.])(?:window\.|globalThis\.)?setInterval\s*\(/g },
  {
    kind: 'self-rescheduling-timeout',
    pattern: /(?:^|[^\w$.])(?:window\.|globalThis\.)?setTimeout\s*\(/g,
    rescheduling: true
  },
  {
    kind: 'self-rescheduling-frame',
    pattern: /(?:^|[^\w$.])(?:window\.)?requestAnimationFrame\s*\(/g,
    rescheduling: true
  }
]

const RESCHEDULE_CALL_DEPTH = 3

// A timeout/frame only counts when its callback reaches its own enclosing scheduler within
// RESCHEDULE_CALL_DEPTH same-file calls (poll -> run -> scheduleNext -> poll is depth 3).
function reschedulesItself(args, names, bodies) {
  const firstArg = args
    .split(',')[0]
    .trim()
    .replace(/^this\./, '')
  let frontier = new Set([...calleesOf(args), firstArg])
  const reached = new Set(frontier)
  for (let depth = 1; depth < RESCHEDULE_CALL_DEPTH; depth++) {
    const next = new Set()
    for (const callee of frontier) {
      for (const nested of calleesOf(bodies.get(callee) ?? '')) {
        if (!reached.has(nested)) {
          reached.add(nested)
          next.add(nested)
        }
      }
    }
    frontier = next
  }
  return names.some((name) => reached.has(name))
}

export function scanSource(relPath, source, helperNames = []) {
  const code = stripNonCode(source)
  const scopes = collectScopes(code)
  const bodies = bodiesByName(scopes, code)
  const importsWatcher = /from\s+['"](?:@parcel\/watcher|chokidar)['"]/.test(source)
  const importsFork =
    /import\s*\{[^}]*\bfork\b[^}]*\}\s*from\s+['"](?:node:)?child_process['"]/.test(source)
  const found = []
  const add = (kind, index, args) => {
    const names = enclosingNames(scopes, index)
    const anchor = names.at(-1) ?? '<module>'
    const spawnText = args + [...calleesOf(args)].map((c) => bodies.get(c) ?? '').join('\n')
    found.push({
      file: relPath,
      kind,
      anchor,
      line: code.slice(0, index).split('\n').length,
      spawnsDetected: SPAWN_CALL.test(spawnText)
    })
  }
  for (const { kind, pattern, rescheduling } of TIMER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const index = match.index + match[0].length - 1
      const args = callArguments(code, match.index)
      if (rescheduling && !reschedulesItself(args, enclosingNames(scopes, match.index), bodies)) {
        continue
      }
      add(kind, index, args)
    }
  }
  const structural = [
    {
      kind: 'watcher',
      pattern: /(?:^|[^\w$])(?:fs\.)?(?:watch|watchFile)\s*\(/g,
      when: /(?:^|[^\w$])fs\.(?:watch|watchFile)\s*\(|from\s+['"](?:node:)?fs['"]/.test(source)
    },
    {
      kind: 'watcher',
      pattern: /\.subscribe\s*\(|(?:^|[^\w$])chokidar\.watch\s*\(/g,
      when: importsWatcher
    },
    { kind: 'worker', pattern: /\bnew\s+Worker\s*\(|utilityProcess\.fork\s*\(/g, when: true },
    { kind: 'worker', pattern: /(?:^|[^\w$.])fork\s*\(/g, when: importsFork },
    // The estate forks IPC children through this wrapper (AGENTS.md, "Forked IPC Children"). It
    // imports no `fork` from child_process and its name does not match a bare `fork(`, so both
    // rules above miss it — and the six sites it owns include the terminal daemon.
    {
      kind: 'worker',
      pattern: /(?:^|[^\w$.])forkIpcChild\s*\(/g,
      // Not in the module that DEFINES it: `export function forkIpcChild(` matches this pattern as
      // a call. Its own inner fork is that file's business and was never counted here.
      when: !relPath.endsWith('ipc-message-listener-floor.ts')
    }
  ]
  for (const { kind, pattern, when } of structural) {
    if (!when) {
      continue
    }
    for (const match of code.matchAll(pattern)) {
      if (
        kind === 'watcher' &&
        /(?:^|[^\w$])watch\s*\($/.test(match[0]) &&
        !/fs\.watch|watchFile/.test(match[0]) &&
        !/import\s*\{[^}]*\bwatch\b[^}]*\}\s*from\s+['"](?:node:)?fs(?:\/promises)?['"]/.test(
          source
        )
      ) {
        continue
      }
      add(kind, match.index + match[0].length - 1, callArguments(code, match.index))
    }
  }
  for (const helper of helperNames) {
    for (const match of code.matchAll(new RegExp(`(?:^|[^\\w$.])${helper}\\s*\\(`, 'g'))) {
      const names = enclosingNames(scopes, match.index)
      if (
        names.includes(helper) ||
        /\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, match.index - 12), match.index + 1))
      ) {
        continue
      }
      add(`helper:${helper}`, match.index, callArguments(code, match.index))
    }
  }
  return numberOccurrences(found)
}

// Identity is file + kind + enclosing symbol, with an ordinal only when a symbol holds several.
function numberOccurrences(sites) {
  const seen = new Map()
  return sites
    .sort((a, b) => a.line - b.line)
    .map((site) => {
      const base = `${site.file}#${site.kind}#${site.anchor}`
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      return { ...site, key: n === 1 ? base : `${base}#${n}` }
    })
}

async function listFiles(dir, root) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full).split(path.sep).join('/')
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        files.push(...(await listFiles(full, root)))
      }
    } else if (isScannedPath(rel)) {
      files.push(rel)
    }
  }
  return files
}

export async function scanRecurringWork(root, helperNames = [], scanRoots = SCAN_ROOTS) {
  const sites = []
  for (const scanRoot of scanRoots) {
    const dir = path.join(root, scanRoot)
    const exists = await fs.stat(dir).then(
      () => true,
      () => false
    )
    if (!exists) {
      continue
    }
    for (const rel of await listFiles(dir, root)) {
      sites.push(...scanSource(rel, await fs.readFile(path.join(root, rel), 'utf8'), helperNames))
    }
  }
  return sites.sort((a, b) => a.key.localeCompare(b.key))
}
