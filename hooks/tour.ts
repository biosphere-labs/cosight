// cosight: the pure half of the mod. Nothing here touches `$`, so the
// tests call these functions directly.
//
//   parseTour      reads what follows /tour: on, off, quiet, voice, history, a lens, a target
//   historyText    the /tour history list: kept tours newest first, numbered
//   clampRange     keeps a requested range inside the file and under MAX_LINES
//   spoken         turns the `say` text into something pleasant to hear
//   askFor         the system-prompt section that tells Claude how to tour
//   overviewText   its paragraph about the project overview diagram: the cached one to
//                  name boxes in, or a request to draw one
//   promptFor      the prompt /tour <lens> <target> submits for the person
//   claimAsk       whether an aside answers a question from the page (else it is refused)
//   readingStatus  one line for the page's progress card from a tool call Claude
//                  makes while it reads the code ("Reading hooks/tour.ts")
//   requestsOf / pageRequestsText
//                  what the person pressed on the web page (a question, Hold),
//                  read from the canvas's requests.jsonl and put into words for Claude

import type { Lens, Overview, PageAsk, PageRequest, Range } from '../types'

/** The most lines one stop is about. The page shows the whole file; this is the focus. */
export const MAX_LINES = 80

/** The tools' full names, as the model calls them. */
export const TOOL = 'mcp__cosight__show'
export const PLAN_TOOL = 'mcp__cosight__plan'

const LENS_WORDS: Record<string, Lens> = {
  perf: 'performance',
  performance: 'performance',
  impl: 'implementation',
  implementation: 'implementation',
  design: 'implementation',
  bug: 'bugs',
  bugs: 'bugs',
  debug: 'bugs',
  general: 'general',
}

export type TourArgs =
  | { action: 'on' | 'off' | 'quiet' | 'voice' }
  | { action: 'speed'; rate: number | null }
  /** n: null lists the kept tours; otherwise the number picked (checked against the list later). */
  | { action: 'history'; n: number | null }
  | { action: 'start'; lens: Lens | null; target: string }

/**
 * What follows /tour. A bare /tour or "on" switches it on; "off", "quiet"
 * and "voice" do what they say, "speed <0.6-2>" sets the page's voice speed; otherwise an optional lens word comes first
 * and the rest is what to tour through (a path, a symbol, a question). "history" alone or with one
 * word after it is the kept-tours list (`/tour history` once started a tour of "history"); with
 * more words it is a question about history, toured like any other.
 */
export function parseTour(args: string): TourArgs {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const first = words[0]?.toLowerCase()
  if (!first || first === 'on') return { action: 'on' }
  if (first === 'off' || first === 'quiet' || first === 'voice') return { action: first }
  if (first === 'history' && words.length <= 2) return { action: 'history', n: words[1] === undefined ? null : Number(words[1]) }
  if (first === 'speed' || first === 'rate') {
    // 0.6 to 2, as the page's own control allows; anything else is reported, not applied.
    const n = Number(words[1])
    return { action: 'speed', rate: Number.isFinite(n) && n >= 0.6 && n <= 2 ? n : null }
  }
  const lens = LENS_WORDS[first] ?? null
  return { action: 'start', lens, target: (lens ? words.slice(1) : words).join(' ') }
}

/** A range inside 1..total, at most MAX_LINES long, start before end. */
export function clampRange(start: number, end: number, total: number): { start: number; end: number } {
  const last = Math.max(1, total)
  let s = Math.min(Math.max(1, Math.floor(start) || 1), last)
  let e = Math.min(Math.max(s, Math.floor(end) || s), last)
  if (e - s + 1 > MAX_LINES) e = s + MAX_LINES - 1
  return { start: s, end: e }
}

/**
 * The `say` text as it should be heard: backticks and markdown dropped, and
 * each path cut to its last segment, as the tts skill asks ("runner dot ts",
 * not every folder on the way).
 */
export function spoken(text: string): string {
  return text
    .replace(/`+/g, '')
    .replace(/[*_#>]+/g, '')
    .replace(/(?:~|\.{1,2})?(?:\/[\w.@-]+){2,}/g, p => p.split('/').at(-1) ?? p)
    .replace(/\s+/g, ' ')
    .trim()
}

const LENS_TEXT: Record<Lens, string> = {
  general: 'Explain what the code does and why it is shaped that way.',
  performance:
    'Focus on performance: the hot path, work repeated per item, allocations, I/O and waiting, ' +
    'complexity, and what you would measure before changing anything.',
  implementation:
    'Focus on implementation: the structure, how data flows through it, the design choices and the ' +
    'alternatives they rule out, and anything surprising.',
  bugs:
    'Focus on finding a bug: follow the inputs and the state through the code, say what you expect ' +
    'at each stop, point at where it can go wrong, and say what evidence would confirm it.',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 14, 2026" from milliseconds since the epoch, in UTC (no Intl in the hooks runtime). */
export function shortDate(ms: number): string {
  const d = new Date(ms)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

/**
 * The ask's paragraph about the project overview diagram. With one cached for this project,
 * Claude is shown it and asked to name the box each stop lives in (or redraw it if the code
 * has moved on); without one, Claude is asked to draw it in the plan.
 */
export function overviewText(overview: Pick<Overview, 'src' | 'written'> | null | undefined): string {
  if (overview?.src) {
    return (
      `The project already has an overview diagram, drawn ${shortDate(overview.written)}, which the page zooms into at each stop:\n` +
      '```mermaid\n' +
      `${overview.src}\n` +
      '```\n' +
      'Give every route stop a "node": the id of the box in it the stop lives in. If the code has changed ' +
      'so this diagram no longer fits, draw a new one in plan\'s "overview" and name its boxes instead.'
    )
  }
  return (
    'Also give plan an "overview": a Mermaid flowchart (flowchart LR or TD) of the whole project, its ' +
    'modules and components, the picture a README would show, ten to fifteen boxes, each with a short ' +
    'plain id such as api, worker, db and a quoted label. The page keeps it for every later tour of this ' +
    'project and zooms into it at each stop, so give every route stop a "node": the id of the box it lives in.'
  )
}

/** The system-prompt section while a tour is on; `overview` is the project's cached diagram, if any. */
export function askFor(lens: Lens, overview?: Pick<Overview, 'src' | 'written'> | null): string {
  return [
    'CoSight is on. The person follows on a web page that shows each stop and reads it aloud; they type back.',
    `Read the code first and plan the whole route before showing anything. Then call ${PLAN_TOOL} once ` +
      'with the question the tour answers and five to nine short stop titles in order; fewer for a small question.',
    // The page shows stop 1 the moment it lands and plays the rest as they arrive, so the sooner
    // each stop is written the sooner the person hears it. Nothing waits on speech any more.
    `Then call ${TOOL} once per stop, in route order, with "stop" set to its number, one call straight ` +
      'after another with no reading or reply in between: the page shows the whole file, scrolled to your ' +
      `range of at most ${MAX_LINES} lines, with "highlight" naming the lines you are talking about. ` +
      'The page plays each stop as it arrives, so write them promptly; a call returns at once.',
    'Put what you would say at that stop in "say": one to three short spoken sentences, plain ' +
      'English, no paths, no code read out symbol by symbol, no markdown. Put detail worth reading ' +
      'in "note". Do not repeat the "say" text in your reply.',
    // The person reads the tour in the browser, where the diagram sits beside the code. A
    // diagram on some stops only reads as a missing diagram.
    'Give every route stop a diagram in "svg": a Mermaid flowchart (flowchart LR or TD) of the flow ' +
      'the tour follows, about ten boxes at most, with what the code alone cannot show (who calls whom, ' +
      'the branch that fails, where data goes). Put every node label in quotes, A["like this"], so ' +
      'slashes, brackets and parentheses in it do not break the diagram. Keep the same diagram from stop ' +
      'to stop and change only what moved, and mark the box this stop is about with a class (classDef here ..., class X here). ' +
      'Give every node a short plain id (api, parse, retry), not a long or generated one. ' +
      'Set "mode" to "map" for a stop where the diagram matters more than the code. ' +
      // The page pans its diagram to the box the voice is on; the ids
      // have to be this stop's own, since that is the diagram on screen while it plays.
      'With a stop\'s own diagram, also give "focus": one entry per sentence of "say", in order, each the id ' +
      'of the box in that diagram the sentence talks about, or "" for none, so the page can pan to the box ' +
      'the voice is talking about.',
    // The whole project's picture, drawn once and kept per project; each stop names its box so
    // the page can zoom the overview to it and animate between stops.
    overviewText(overview),
    LENS_TEXT[lens],
    // Every terminal reply used to land on the page as an aside, so a tour ended in a pile of
    // pages that were just the rest of the session ("go", "good", ...).
    'Asides are only for questions asked on the tour page. The person may ask from the web page: a typed ' +
      `question, a question about a box they clicked in the diagram, or Hold. Those reach you in a ${TOOL} or ${PLAN_TOOL} result, or as a cosight ` +
      `message once you are idle. Answer such a question with a ${TOOL} call carrying "ask" (their question, ` +
      'in their words): an aside, listed under the stop it was asked at and kept out of the numbering; then go ' +
      'on with any route stops still unwritten. On Hold, finish the stop you are on and stop.',
    'What the person types in the terminal is answered in the terminal, in your reply, never as a stop on ' +
      `the page. When they type a new question about how code works, start a new tour: read the code and call ` +
      `${PLAN_TOOL} again; the page clears and shows the new route.`,
    'After the last stop, end the turn with one short sentence; the page is still reading the stops out. ' +
      'Do not edit files during a tour unless asked.',
  ].join('\n')
}

/** The prompt /tour <lens> <target> submits, in the person's name. */
export function promptFor(lens: Lens, target: string): string {
  const focus = lens === 'general' ? '' : ` with a ${lens} focus`
  return `Walk me through ${target}${focus}.`
}

/** The last two path segments, so a status line names the file without every folder on the way. */
function shortPath(p: string): string {
  return p.split('/').filter(Boolean).slice(-2).join('/')
}

/**
 * One line for the page while Claude reads the code before the plan, from a tool call it makes:
 * '' for a tool that says nothing about reading (the tour's own tools, an edit, a spawn).
 */
export function readingStatus(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => String(input[k] ?? '').trim()
  switch (tool) {
    case 'Read':
      return str('file_path') ? `Reading ${shortPath(str('file_path'))}` : 'Reading a file'
    case 'Grep':
      return str('pattern') ? `Searching for ${str('pattern').slice(0, 40)}` : 'Searching the code'
    case 'Glob':
      return str('pattern') ? `Looking for ${str('pattern').slice(0, 40)}` : 'Looking for files'
    case 'Bash':
      return 'Running a command'
    case 'Agent':
    case 'Task':
      return str('description') ? `Exploring: ${str('description').slice(0, 50)}` : 'Exploring the code'
    case 'WebFetch':
    case 'WebSearch':
      return 'Looking something up'
    default:
      return ''
  }
}

/** Highlight ranges from the tool input, dropping anything malformed. */
export function rangesOf(raw: unknown): Range[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(r => {
    const from = Number((r as Range)?.from)
    const to = Number((r as Range)?.to ?? from)
    return Number.isFinite(from) && Number.isFinite(to) ? [{ from: Math.min(from, to), to: Math.max(from, to) }] : []
  })
}

/** The tool's input schema, as the model reads it. */
export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'The file, absolute or relative to the working directory. The page shows all of it.' },
    start: { type: 'integer', description: 'First line of the range this stop is about, 1-based; the page scrolls here.' },
    end: { type: 'integer', description: `Last line of the range; at most ${MAX_LINES} lines per stop.` },
    highlight: {
      type: 'array',
      description: 'The lines under discussion, as ranges inside start..end.',
      items: {
        type: 'object',
        properties: { from: { type: 'integer' }, to: { type: 'integer' } },
        required: ['from'],
      },
    },
    title: { type: 'string', description: 'A short heading for this stop, a few words.' },
    stop: { type: 'integer', description: 'This stop\'s number in the planned route, 1-based. Omit for an aside.' },
    say: { type: 'string', description: 'One to three short spoken sentences for this stop, read aloud by the page.' },
    note: { type: 'string', description: 'Optional detail to read, shown under the code.' },
    ask: {
      type: 'string',
      description:
        'Only when this stop answers a question the person asked on the tour page: their question, in their ' +
        'words. The stop is then shown as an aside under the stop it was asked at, with a way back. Refused ' +
        'otherwise: answer the terminal in the terminal, and start a new tour with plan for a new question.',
    },
    svg: {
      type: 'string',
      description:
        'The diagram for the page\'s diagram pane, on every route stop: what the excerpt cannot show ' +
        '(control flow across files, a data shape, who calls whom). Mermaid syntax (flowchart, ' +
        'sequenceDiagram, classDiagram, ...; classDef, class, style and linkStyle lines are fine) is ' +
        'rendered through the vendored Mermaid library; content starting with a literal "<svg" is injected ' +
        'as-is instead, for a hand-drawn diagram Mermaid cannot express (such as one linking nodes to code ' +
        'lines with data-lines). A stop that gives none keeps the tour\'s last diagram on the page.',
    },
    node: {
      type: 'string',
      description:
        'The id of the box in the project overview diagram this stop lives in (its Mermaid node id, e.g. api). ' +
        'Every route stop should have one.',
    },
    focus: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Only with this stop\'s own "svg": one entry per sentence of "say", in order, each the id of the box ' +
        'in that diagram the sentence talks about (a node id from it), or "" for none, so the page can pan to ' +
        'the box the voice is talking about.',
    },
    diagramCaption: { type: 'string', description: 'Caption over the diagram pane; only with "svg".' },
    diagramWhy: { type: 'string', description: 'One short phrase under the diagram caption, e.g. "the box in colour is this stop".' },
    codeWhy: { type: 'string', description: 'Same, for the code pane, e.g. "the branch that does the choosing".' },
    mode: {
      type: 'string',
      enum: ['split', 'map', 'code'],
      description: 'Pane layout to suggest: split (default), map (diagram leads), or code (code leads). The person\'s own choice on the page wins.',
    },
  },
  required: ['file', 'start', 'end', 'say'],
} as const

/** The show tool's `focus`: each entry a trimmed string ('' for anything that is not one), at most 40. */
export function focusOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 40).map(f => (typeof f === 'string' ? f.trim() : ''))
}

/** A question as compared: case, spacing and closing punctuation do not tell two apart. */
const askKey = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').replace(/[\s?.!]+$/, '').trim()

/**
 * Whether an aside asking `ask` answers a question from the page, and the page's questions
 * after it does: the one it names is marked answered (else the oldest still open). A question
 * already answered may take another aside (one answer can need two stops); with no open
 * question and no match, `null`: the aside came from the terminal and is refused.
 */
export function claimAsk(asks: readonly PageAsk[], ask: string): PageAsk[] | null {
  const key = askKey(ask)
  let i = asks.findIndex(a => !a.isAnswered && askKey(a.text) === key)
  if (i < 0) i = asks.findIndex(a => !a.isAnswered)
  if (i < 0) return asks.some(a => askKey(a.text) === key) ? [...asks] : null
  return asks.map((a, j) => (j === i ? { ...a, isAnswered: true } : a))
}

/** The plan tool's input schema. */
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The question the whole tour answers, in one sentence.' },
    stops: {
      type: 'array',
      description: 'The stop titles in route order, a few words each; five to nine for most tours.',
      items: { type: 'string' },
    },
    overview: {
      type: 'string',
      description:
        'The project overview diagram: a Mermaid flowchart (flowchart LR or TD) of the whole project, its ' +
        'modules and components, ten to fifteen boxes, each with a short plain id (api, worker, db) and a ' +
        'quoted label. Drawn once per project and kept for every later tour of it; each stop then names the ' +
        'box it lives in with "node". Omit it when the project already has one that still fits the code.',
    },
    overviewCaption: { type: 'string', description: 'A short caption over the overview diagram; only with "overview".' },
  },
  required: ['question', 'stops'],
} as const

/** A plan from the tool input: a trimmed question and the non-empty titles, at most 12. */
export function routeOf(raw: { question?: unknown; stops?: unknown }) {
  const question = String(raw.question ?? '').trim()
  const stops = Array.isArray(raw.stops) ? raw.stops.map(t => String(t ?? '').trim()).filter(Boolean).slice(0, 12) : []
  return { question, stops }
}

/** The overview a plan gives, trimmed, or null when it gives none. */
export function overviewOf(raw: { overview?: unknown; overviewCaption?: unknown }): { src: string; caption: string } | null {
  const src = String(raw.overview ?? '').trim()
  return src ? { src, caption: String(raw.overviewCaption ?? '').trim() } : null
}

/**
 * The lines of requests.jsonl after the first `seen`, parsed. tour-server.js appends one JSON
 * object per press of the page's Send and Hold on buttons and per question asked of a diagram
 * box; a line that does not parse is skipped, never fatal.
 *
 * @returns the new requests and the line count to remember as seen
 */
export function requestsOf(text: string, seen: number): { requests: PageRequest[]; total: number } {
  const lines = text.split('\n').filter(l => l.trim())
  const requests = lines.slice(Math.max(0, seen)).flatMap(l => {
    try {
      const o = JSON.parse(l) as Record<string, unknown>
      return [{ ...(typeof o.project === 'string' ? { project: o.project } : {}), kind: String(o.kind ?? ''), text: String(o.text ?? '').trim(), step: Number(o.step) || 0, heading: String(o.heading ?? '') }]
    } catch {
      return []
    }
  })
  return { requests, total: lines.length }
}

/**
 * What the page's requests ask of Claude, in words, or '' when nothing does.
 *
 * Mid-turn (`isIdle` false) the text rides on a tool result, so Hold is said too: Claude is
 * between stops and can stop there. Once Claude is idle the text starts a turn of its own,
 * and a Hold says nothing new: Claude is already waiting.
 */
export function pageRequestsText(requests: readonly PageRequest[], isIdle: boolean): string {
  const lines = requests.flatMap(r => {
    const at = r.step ? ` at stop ${r.step}${r.heading ? ` ("${r.heading}")` : ''}` : ''
    if (r.kind === 'tour' && r.text) return [`Start a new tour with plan (not an aside). Follow these instructions:\n${r.text}`]
    if (r.kind === 'question' && r.text) {
      return [`On the tour page${at}, the person asked: "${r.text}". Answer it as an aside: call ${TOOL} with "ask" ` +
        'set to their question, in their words, then go on with any route stops still unwritten.']
    }
    if (r.kind === 'advance') return [`On the tour page${at}, the person asked for the next stop${r.step ? `: show stop ${r.step + 1}` : ''}.`]
    if (r.kind === 'hold' && !isIdle) return [`On the tour page${at}, the person pressed Hold: stop after this and wait for them.`]
    return []
  })
  return lines.join('\n')
}

/** One kept tour as /tour history lists it; `isLive` for the one on the page that is not archived yet. */
export type HistoryEntry = { ms: number; question: string; stops: number; answers: number; isLive: boolean }

/** The most tours /tour history lists; older ones stay on disk. */
export const HISTORY_MAX = 30

/**
 * The /tour history reply: one numbered line per tour, newest first, as
 * `3  Oct 19, 2026  Why does the merge gate refuse…  (8 stops, 14 answers)`, and how to reopen one.
 */
export function historyText(entries: readonly HistoryEntry[]): string {
  if (entries.length === 0) return 'CoSight: no tours kept yet. A tour is kept when a new one replaces it or /tour off ends it.'
  const width = String(entries.length).length
  const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`
  const lines = entries.map((t, i) => {
    const q = t.question.length > 60 ? `${t.question.slice(0, 59)}…` : t.question || '(no question)'
    const live = t.isLive ? ' (on the page)' : ''
    return `${String(i + 1).padStart(width)}  ${shortDate(t.ms)}  ${q}  (${plural(t.stops, 'stop')}, ${plural(t.answers, 'answer')})${live}`
  })
  return [...lines, '', '/tour history <n> reopens one on the page.'].join('\n')
}
