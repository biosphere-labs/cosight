// cosight: GapStyle colouring for the terminal pane.
//
// GapStyle (github.com/gaplo917/GapStyle, MIT, by Gary Lo) gives one colour to each kind of
// construct, the same in every language, so a reader new to a language still finds its
// keywords, calls, types and constants by colour. A lexical pass cannot see real semantics,
// so each kind below is a heuristic named after the construct it stands for. The same rules
// drove the browser tour's highlighter, which this replaces.
//
//   tokenize(line, state)  one line into coloured pieces; `state` carries an open block
//                          comment or template string to the next line
//   COLOR                  each kind's GapStyle colour, and whether it is bold

/** The kinds of construct the pane colours. */
export type Kind =
  | 'plain' | 'keyword' | 'function' | 'type' | 'number' | 'string' | 'interp' | 'regex'
  | 'constant' | 'member' | 'local' | 'decorator' | 'comment' | 'doc' | 'docTag' | 'docLink'

/** One coloured piece of a line. */
export type Piece = { kind: Kind; text: string }

/** What is still open at the end of a line. */
export type LexState = { block: null | 'comment' | 'doc'; template: boolean }

/** GapStyle's colours (the VS Code theme's values), keywords and doc tags bold. */
export const COLOR: Record<Kind, { color: string; bold?: true }> = {
  plain: { color: '#A9B7C6' },
  keyword: { color: '#F92672', bold: true },
  function: { color: '#A6E22E' },
  type: { color: '#66D9EF' },
  number: { color: '#AE81FE' },
  string: { color: '#E6DB75' },
  interp: { color: '#CC7832' },
  regex: { color: '#CC7832' },
  constant: { color: '#4186F8' },
  member: { color: '#CF8823' },
  local: { color: '#CBAD96' },
  decorator: { color: '#BBB529' },
  comment: { color: '#808080' },
  doc: { color: '#77B767' },
  docTag: { color: '#526D4A', bold: true },
  docLink: { color: '#8A653B' },
}

const KEYWORDS = new Set(
  ('abstract as async await boolean break case catch class const continue declare def default delete do elif else enum ' +
    'export extends final finally for from fn func function get if impl implements import in instanceof interface is ' +
    'let match mod module mut namespace new of override package private protected pub public readonly record return ' +
    'satisfies sealed self set static struct super switch this throw throws trait try type typeof use val var void when ' +
    'where while with yield').split(' '),
)
const LITERALS = new Set('null None True False true false nil undefined NaN Infinity'.split(' '))
const DECLARES = new Set(['const', 'let', 'var', 'val'])
const NAMES_FUNCTION = new Set(['function', 'def', 'fun', 'fn'])
/** What may come before a `/` that starts a regex literal rather than a division. */
const REGEX_BEFORE = /(^|[(,=:[!&|?{};]|\breturn|\btypeof)\s*$/

/**
 * The line-comment markers for a language: `--` only for SQL-like languages, `#` only for
 * shell-like ones, otherwise `//`, so `count--` and `#private` are never read as comments.
 */
export function commentStarts(lang: string): string[] {
  if (/^(sql|plsql|tsql|pgsql|hql|lua|hs|haskell|ada)$/i.test(lang)) return ['--']
  if (/^(py|python|sh|bash|zsh|yaml|yml|toml|rb|ruby|r|perl|ps1|powershell|make|dockerfile|conf|ini)$/i.test(lang)) return ['#']
  return ['//']
}

/** The language a path suggests, by extension, for the comment markers. */
export function langOf(path: string): string {
  return /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''
}

/** A doc comment's text with @tags and {@link ...} picked out. */
function docPieces(text: string): Piece[] {
  const out: Piece[] = []
  const re = /(\{@\w+[^}]*\})|(@\w+)/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: 'doc', text: text.slice(last, m.index) })
    out.push({ kind: m[1] ? 'docLink' : 'docTag', text: m[0] })
    last = re.lastIndex
  }
  if (last < text.length) out.push({ kind: 'doc', text: text.slice(last) })
  return out
}

/**
 * One line, left to right, into coloured pieces.
 *
 * @param line the line's text
 * @param lang the language, from {@link langOf}
 * @param state what the previous line left open; updated for the next line
 */
export function tokenize(line: string, lang: string, state: LexState): Piece[] {
  const comments = commentStarts(lang)
  const out: Piece[] = []
  const push = (kind: Kind, text: string) => {
    if (!text) return
    const last = out.at(-1)
    if (last && last.kind === kind) last.text += text
    else out.push({ kind, text })
  }
  let i = 0
  let prevWord = ''
  const n = line.length
  while (i < n) {
    if (state.block) {
      const end = line.indexOf('*/', i)
      const stop = end < 0 ? n : end + 2
      const part = line.slice(i, stop)
      if (state.block === 'doc') docPieces(part).forEach(p => push(p.kind, p.text))
      else push('comment', part)
      if (end >= 0) state.block = null
      i = stop
      continue
    }
    if (state.template) {
      let j = i
      while (j < n && line[j] !== '`' && line.slice(j, j + 2) !== '${') j += line[j] === '\\' ? 2 : 1
      push('string', line.slice(i, j))
      if (j >= n) break
      if (line[j] === '`') {
        push('string', '`')
        state.template = false
        i = j + 1
        continue
      }
      const close = line.indexOf('}', j) < 0 ? n - 1 : line.indexOf('}', j)
      push('interp', '${')
      tokenize(line.slice(j + 2, close), lang, { block: null, template: false }).forEach(p => push(p.kind, p.text))
      push('interp', '}')
      i = close + 1
      continue
    }
    const rest = line.slice(i)
    const ch = line[i]!
    if (rest.startsWith('/**') && !rest.startsWith('/**/')) {
      state.block = 'doc'
      continue
    }
    if (rest.startsWith('/*')) {
      state.block = 'comment'
      continue
    }
    if (comments.some(c => rest.startsWith(c))) {
      push('comment', rest)
      break
    }
    if (ch === '`') {
      push('string', '`')
      state.template = true
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      let k = i + 1
      while (k < n) {
        if (line[k] === '\\') {
          k += 2
          continue
        }
        if (line[k] === ch) break
        k++
      }
      const end = Math.min(k + 1, n)
      push('string', line.slice(i, end))
      i = end
      continue
    }
    if (ch === '/' && REGEX_BEFORE.test(line.slice(0, i))) {
      const r = /^\/(?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+\/[a-z]*/.exec(rest)
      if (r) {
        push('regex', r[0])
        i += r[0].length
        continue
      }
    }
    const num = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?/.exec(rest)
    if (num && !/[A-Za-z0-9_$]/.test(line[i - 1] ?? '')) {
      push('number', num[0])
      i += num[0].length
      continue
    }
    const dec = ch === '@' ? /^@[A-Za-z_][\w.]*/.exec(rest) : null
    if (dec) {
      push('decorator', dec[0])
      i += dec[0].length
      continue
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest)?.[0]
    if (word) {
      const after = line.slice(i + word.length)
      const before = line.slice(0, i)
      let kind: Kind = 'plain'
      if (KEYWORDS.has(word)) kind = 'keyword'
      else if (LITERALS.has(word)) kind = 'constant'
      else if (/^\s*(?:<[^>()]*>)?\s*\(/.test(after) || NAMES_FUNCTION.has(prevWord)) kind = 'function'
      else if (/\.\s*$/.test(before)) kind = 'member'
      else if (/^[A-Z][A-Z0-9_]+$/.test(word)) kind = 'constant'
      else if (/^[A-Z]/.test(word)) kind = 'type'
      else if (DECLARES.has(prevWord)) kind = 'local'
      push(kind, word)
      prevWord = word
      i += word.length
      continue
    }
    if (!/\s/.test(ch)) prevWord = ch === ',' && DECLARES.has(prevWord) ? prevWord : ''
    push('plain', ch)
    i++
  }
  return out
}

/** The state an excerpt starts in: inside a doc comment when its first line is ` * ...`. */
export function startState(firstLine: string): LexState {
  return { block: /^\s*\*(?!\/)/.test(firstLine) ? 'doc' : null, template: false }
}
