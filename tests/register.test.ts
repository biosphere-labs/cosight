// The mod in the engine: switching on registers the tools, starts the web page and puts its URL
// on the status line, with no pane in the terminal; every change writes the whole tour.json at
// once, nothing waits on speech; the page is told where Claude is while there is nothing to show;
// what the person presses on the page reaches Claude, mid-tour or once idle.
import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { archivePath, fileKey } from '../hooks/canvas'

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const
const URL = 'http://127.0.0.1:8099/'
const WORKDIR = '/home/me/.local/share/cosight'
const DOC = `${WORKDIR}/tour.json`
const REQUESTS = `${WORKDIR}/requests.jsonl`
const TOURS = `${WORKDIR}/tours`
/** The cwd's overview cache file: overviews/<fileKey('/work')>.json. */
const OVERVIEW_FILE = `${WORKDIR}/overviews/${fileKey('/work')}.json`
const FLOW = 'flowchart LR\n  api["API"] --> db["Database"]'
const tour = (args: string) =>
  ({ command: 'tour', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } }) as const

/** What every session asks first: its start, and each command it registers. */
function starts(on: On) {
  on('session.start', (_engine, e) => ({ cwd: e.cwd }))
  on('command.register', (_engine, e) => ({ value: { command: e.name } }))
}

type Doc = {
  v: number; tourId: string; phase: string; status: string; question: string; mute: { v: number; on: boolean }
  speed: { v: number; rate: number }
  project: string; projectKey: string
  overview?: { src: string; caption: string; written: number }
  plan: { n: number; title: string }[]
  stops: Record<string, unknown>[]
  asides: Record<string, unknown>[]
}

/**
 * A world with one source file, the page's requests.jsonl as `w.requests` lines, and every call
 * the mod makes recorded: `w.log` keeps document writes, file writes and processes in the order
 * they happened; `w.docs` every tour.json written; `w.files` every files/<key>.txt path written;
 * `w.overview` the text of the project's overview cache file on disk (null: no such file), which
 * a write to it replaces.
 */
function world(on: On, now = 0) {
  starts(on)
  const w = {
    registered: [] as string[],
    opened: [] as string[],
    statuses: [] as (string | undefined)[],
    log: [] as string[],
    docs: [] as Doc[],
    files: [] as string[],
    overview: null as string | null,
    overviewWrites: [] as string[],
    /** Every tours/<...>.json written: where, and the tour it holds. */
    archives: [] as { path: string; doc: Doc }[],
    /** True: every write under tours/ fails. */
    isArchiveBroken: false,
    /** What is on disk under tours/, by path: every archive written, and any a test lays there. */
    tours: new Map<string, string>(),
    submitted: [] as string[],
    requests: [] as string[],
    clock: mock.clock(on, { now }),
  }
  on('env.get', (_engine, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', (_engine, e) => ({ value: e.path.includes('/files/') ? w.files.includes(e.path) : true }))
  on('fs.read', (_engine, e) => {
    if (e.path === REQUESTS) return { value: w.requests.join('\n') }
    if (e.path.includes('/tours/')) {
      const text = w.tours.get(e.path)
      if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
      return { value: text }
    }
    if (e.path.includes('/overviews/')) {
      if (e.path !== OVERVIEW_FILE || w.overview === null) throw new Error(`ENOENT: ${e.path}`)
      return { value: w.overview }
    }
    if (e.path.endsWith('b.ts')) return { value: ['alpha', 'beta'].join('\n') }
    return { value: ['one', 'two', 'three', 'four', 'five'].join('\n') }
  })
  on('fs.write', (_engine, e) => {
    if (e.path === DOC) {
      w.docs.push(JSON.parse(e.text) as Doc)
      w.log.push('doc')
    } else if (e.path.includes('/files/')) {
      w.files.push(e.path)
      w.log.push('file')
    } else if (e.path.includes('/tours/')) {
      if (w.isArchiveBroken) throw new Error(`EACCES: ${e.path}`)
      w.archives.push({ path: e.path, doc: JSON.parse(e.text) as Doc })
      w.tours.set(e.path, e.text)
      w.log.push('archive')
    } else if (e.path.includes('/overviews/')) {
      w.overviewWrites.push(e.path)
      w.overview = e.text
      w.log.push('overview')
    }
    return { value: undefined }
  })
  on('fs.list', (_engine, e) => {
    if (e.path !== TOURS) throw new Error(`ENOENT: ${e.path}`)
    const names = [...w.tours.keys()].map(p => p.slice(TOURS.length + 1))
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('tool.register', (_engine, e) => {
    w.registered.push(e.name)
    return { value: { tool: `mcp__cosight__${e.name}` } }
  })
  on('ui.open', (_engine, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.status', (_engine, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('process.run', (_engine, e) => {
    w.log.push(`${e.argv.join(' ')} <- ${e.init?.stdin ?? ''}`)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_engine, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', () => ({ text: '' }))
  // Claude's own reads while it plans: the engine beneath answers them.
  on('tool.call', () => ({ result: 'read' }))
  return w
}

const show = ($: Engine, extra: Record<string, unknown> = {}) =>
  $.tool.call({
    tool: 'mcp__cosight__show',
    file: 'src/a.ts',
    start: 2,
    end: 4,
    highlight: [{ from: 3, to: 3 }],
    title: 'The middle',
    say: 'This loop in `/work/src/a.ts` runs once per item.',
    ...extra,
  } as never)

const lastDoc = (w: { docs: Doc[] }) => w.docs.at(-1)!
const mainTurnEnds = ($: Engine) => $.turn.complete({ answer: '', durationMs: 1, reason: 'answer' } as never)

describe('cosight', () => {
  test('off by default: no ask in the prompt, and the tool is refused', async ($, on) => {
    world(on)
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
    await $.session.start(SESSION)
    expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toEqual(['intro'])
    const r = await show($)
    expect(r.deny).toContain('CoSight is off')
  })

  test('/tour on registers the tools once, starts the page, shows only its URL, adds the ask, and writes an idle document', async ($, on) => {
    const w = world(on)
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
    await $.session.start(SESSION)
    const said = await $.command.run(tour('on'))
    await $.command.run(tour('on'))
    expect(w.registered).toEqual(['plan', 'show'])
    expect(w.log.some(l => /^bash \S+\/assets\/start-canvas\.sh \/home\/me\/\.local\/share\/cosight 8099 127\.0\.0\.1 <- $/.test(l))).toBe(true)
    expect(said.text).toContain(URL)
    expect(w.statuses.at(-1)).toBe(`cosight: ${URL}`)
    // No block in the terminal: no pane is opened, the URL is all it shows.
    expect(w.opened).toEqual([])
    expect(lastDoc(w).phase).toBe('idle')
    const r = await $.prompt.compose(COMPOSE)
    expect(r.sections.map(s => s.id)).toEqual(['intro', 'cosight:ask'])
  })

  test('a stop lands in the document at once, with the whole file beside it, and nothing is spoken here', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    w.log.length = 0
    const r = await show($)
    expect(r.isError).not.toBe(true)
    // The file first, then the document that points at it; no say.sh, no waiting.
    expect(w.log).toEqual(['file', 'doc'])
    expect(w.files[0]).toMatch(new RegExp(`^${WORKDIR}/files/[0-9a-f]{8}-23\\.txt$`))
    const doc = lastDoc(w)
    expect(doc.stops).toHaveLength(1)
    expect(doc.stops[0]).toMatchObject({
      n: 1, file: 'src/a.ts', fileLines: 5, start: 2, end: 4, highlight: [3], lang: 'ts',
      say: 'This loop in a.ts runs once per item.',
    })
    expect(doc.stops[0]!.fileUrl).toBe(`files/${w.files[0]!.split('/').at(-1)}`)
    expect(doc.phase).toBe('writing')
    expect(r.result).toContain('reading it out')
    expect(w.opened).toEqual([])
  })

  test('a file shown twice is written once', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    await show($)
    await show($, { title: 'Again', start: 1, end: 2 })
    await show($, { title: 'Other', file: 'src/b.ts', start: 1, end: 1 })
    expect(w.files).toHaveLength(2)
  })

  test('/tour quiet and voice push mute to the page, each as a new version; the stop still lands', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    await $.command.run(tour('quiet'))
    expect(lastDoc(w).mute).toEqual({ v: 1, on: true })
    await show($)
    expect(lastDoc(w).stops).toHaveLength(1)
    expect(lastDoc(w).mute).toEqual({ v: 1, on: true })
    await $.command.run(tour('voice'))
    expect(lastDoc(w).mute).toEqual({ v: 2, on: false })
  })

  test('/tour speed pushes the voice speed to the page; an impossible one is refused and not pushed', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    expect(lastDoc(w).speed).toEqual({ v: 0, rate: 1 })
    const said = await $.command.run(tour('speed 1.3'))
    expect(said.text).toContain('1.3x')
    expect(lastDoc(w).speed).toEqual({ v: 1, rate: 1.3 })
    const refused = await $.command.run(tour('speed 9'))
    expect(refused.text).toContain('0.6 to 2')
    expect(lastDoc(w).speed).toEqual({ v: 1, rate: 1.3 })
  })

  test('a question answered mid-tour is an aside: unnumbered, under its stop, and the route keeps counting', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    w.requests.push(JSON.stringify({ kind: 'question', text: 'Why does it start at one?', step: 1 }))
    await show($)
    await $.tool.call({
      tool: 'mcp__cosight__show', file: 'src/a.ts', start: 1, end: 2, title: 'Why one',
      say: 'Because.', ask: 'Why does it start at one?',
    } as never)
    const doc = lastDoc(w)
    expect(doc.stops).toHaveLength(1)
    expect(doc.asides).toHaveLength(1)
    expect(doc.asides[0]).toMatchObject({ id: expect.any(String), n: 0, from: 1, ask: 'Why does it start at one?', title: 'Why one' })

    // The next route stop is numbered 2, not 3: the aside took no number.
    await show($, { title: 'The end' })
    expect(lastDoc(w).stops.map(s => s.n)).toEqual([1, 2])
    expect(lastDoc(w).asides).toHaveLength(1)
  })

  test('a plan puts the question and route in the document, starts a tour id, and the status counts the stops', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    const planned = await $.tool.call({
      tool: 'mcp__cosight__plan', question: 'How does the middle work?', stops: ['The start', 'The middle', 'The end'],
    } as never)
    expect(planned.isError).not.toBe(true)
    expect(planned.result).toContain('show stop 1')
    let doc = lastDoc(w)
    expect(doc.plan).toEqual([{ n: 1, title: 'The start' }, { n: 2, title: 'The middle' }, { n: 3, title: 'The end' }])
    expect(doc.question).toBe('How does the middle work?')
    expect(doc.tourId).toMatch(/^t-\d+$/)
    expect(doc.phase).toBe('writing')
    expect(doc.status).toBe('Writing stop 1 of 3')
    expect(doc.stops).toEqual([])
    await $.tool.call({ tool: 'mcp__cosight__show', file: 'src/a.ts', start: 2, end: 4, stop: 2, title: 'The middle', say: 'Here.' } as never)
    doc = lastDoc(w)
    expect(doc.stops.map(s => s.n)).toEqual([2])
    expect(doc.status).toBe('Writing stop 3 of 3')
    const r = await $.tool.call({ tool: 'mcp__cosight__show', file: 'src/a.ts', start: 1, end: 1, stop: 3, title: 'The end', say: 'Done.' } as never)
    expect(lastDoc(w).status).toBe('All stops written')
    expect(r.result).not.toContain('show stop')
    // A stop shown again replaces its earlier showing.
    await $.tool.call({ tool: 'mcp__cosight__show', file: 'src/a.ts', start: 1, end: 2, stop: 2, title: 'The middle, again', say: 'Again.' } as never)
    expect(lastDoc(w).stops.map(s => s.title)).toEqual(['The middle, again', 'The end'])
  })

  test('a stop keeps its diagram in the document; the page keeps the last one when a stop gives none', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    const flow = 'flowchart LR\n  A --> B\n  classDef here fill:#fff8e1\n  class B here'
    await show($, { svg: flow, diagramCaption: 'The loop' })
    await show($, { title: 'The end' })
    const [a, b] = lastDoc(w).stops
    expect(a!.svg).toBe(flow)
    expect(a!.diagramCaption).toBe('The loop')
    expect(b!.svg).toBe('')
  })

  test('every document names the project and its key; with no overview drawn yet, the ask asks for one and the document carries none', async ($, on) => {
    const w = world(on)
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    expect(lastDoc(w)).toMatchObject({ project: '/work', projectKey: fileKey('/work') })
    expect('overview' in lastDoc(w)).toBe(false)
    const ask = (await $.prompt.compose(COMPOSE)).sections.find(s => s.id === 'cosight:ask')!.text
    expect(ask).toContain('Also give plan an "overview"')
    expect(ask).not.toContain('already has an overview')
  })

  test('a plan that draws the overview writes overviews/<key>.json, and the document and the ask carry it from then on', async ($, on) => {
    const w = world(on)
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    const before = await w.clock.now()
    const planned = await $.tool.call({
      tool: 'mcp__cosight__plan', question: 'How does it work?', stops: ['One', 'Two'],
      overview: ` ${FLOW} `, overviewCaption: 'The whole project',
    } as never)
    expect(planned.isError).not.toBe(true)
    // The cache file: the project, its source, caption and when it was drawn.
    expect(w.overviewWrites).toEqual([OVERVIEW_FILE])
    const cached = JSON.parse(w.overview!) as Record<string, unknown>
    expect(cached).toMatchObject({ project: '/work', src: FLOW, caption: 'The whole project' })
    expect(cached.written).toBeGreaterThanOrEqual(before)
    // The cache is written before the document that first carries it.
    expect(w.log.indexOf('overview')).toBeLessThan(w.log.lastIndexOf('doc'))
    const doc = lastDoc(w)
    expect(doc.overview).toEqual({ src: FLOW, caption: 'The whole project', written: cached.written })
    expect(doc.projectKey).toBe(fileKey('/work'))
    // The next turn's ask shows the diagram instead of asking for one.
    const ask = (await $.prompt.compose(COMPOSE)).sections.find(s => s.id === 'cosight:ask')!.text
    expect(ask).toContain('The project already has an overview diagram')
    expect(ask).toContain(FLOW)
    expect(ask).not.toContain('Also give plan an "overview"')
    // Later documents keep carrying it.
    await show($, { stop: 1, node: 'api' })
    expect(lastDoc(w).overview).toEqual(doc.overview)
  })

  test('a plan without an overview reuses the one cached for this project; a broken cache counts as none', async ($, on) => {
    const w = world(on)
    on('prompt.compose', () => ({ sections: [] }))
    // Drawn by an earlier tour of /work.
    w.overview = JSON.stringify({ project: '/work', src: FLOW, caption: 'Kept', written: Date.UTC(2026, 9, 14) })
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    // Switching on reads it: the ask shows it, dated.
    const ask = (await $.prompt.compose(COMPOSE)).sections.find(s => s.id === 'cosight:ask')!.text
    expect(ask).toContain('drawn Oct 14, 2026')
    expect(ask).toContain(FLOW)
    await $.tool.call({ tool: 'mcp__cosight__plan', question: 'Q', stops: ['One'] } as never)
    expect(w.overviewWrites).toEqual([])
    expect(lastDoc(w).overview).toEqual({ src: FLOW, caption: 'Kept', written: Date.UTC(2026, 9, 14) })

    // A cache that is not an overview is treated as absent, never as a failure.
    await $.command.run(tour('off'))
    w.overview = 'one\ntwo\nthree'
    await $.command.run(tour('on'))
    expect('overview' in lastDoc(w)).toBe(false)
    expect((await $.prompt.compose(COMPOSE)).sections.find(s => s.id === 'cosight:ask')!.text).toContain('Also give plan an "overview"')
    const r = await $.tool.call({ tool: 'mcp__cosight__plan', question: 'Q', stops: ['One'] } as never)
    expect(r.isError).not.toBe(true)
    expect('overview' in lastDoc(w)).toBe(false)
  })

  test('a stop carries the overview box it lives in; one that names none has no node', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    await show($, { stop: 1, node: ' api ' })
    w.requests.push(JSON.stringify({ kind: 'question', text: 'Why?', step: 2 }))
    await show($, { stop: 2, title: 'The end' })
    await $.tool.call({ tool: 'mcp__cosight__show', file: 'src/a.ts', start: 1, end: 1, say: 'Because.', ask: 'Why?', node: 'db' } as never)
    const doc = lastDoc(w)
    expect(doc.stops[0]!.node).toBe('api')
    expect('node' in doc.stops[1]!).toBe(false)
    expect(doc.asides[0]!.node).toBe('db')
  })

  test('an aside with no page question waiting is refused, told to answer in the terminal or plan anew', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    await show($, { stop: 1 })
    // The terminal's own conversation ("go", "good") is not a page question.
    const r = await show($, { ask: 'go', title: 'Go' })
    expect(r.deny).toContain('answers a question asked on the tour page')
    expect(r.deny).toContain('in the terminal')
    expect(r.deny).toContain('mcp__cosight__plan')
    expect(lastDoc(w).asides).toEqual([])
    expect(lastDoc(w).stops).toHaveLength(1)
  })

  test('an aside answering a page question is accepted, may take a second stop, and the next stray one is refused', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    await show($, { stop: 1 })
    w.requests.push(JSON.stringify({ kind: 'question', text: 'Why two locks?', step: 1 }))
    expect((await show($, { stop: 2 })).result).toContain('Why two locks?')
    expect((await show($, { ask: 'why two locks', title: 'Two locks' })).deny).toBeUndefined()
    // The same question again: a longer answer, still allowed.
    expect((await show($, { ask: 'Why two locks?', title: 'Two locks, more' })).deny).toBeUndefined()
    expect(lastDoc(w).asides.map(a => a.title)).toEqual(['Two locks', 'Two locks, more'])
    // Answered: a new, unrelated aside has nothing to answer.
    expect((await show($, { ask: 'What I decided without you', title: 'Decisions' })).deny).toContain('tour page')
    expect(lastDoc(w).asides).toHaveLength(2)
  })

  test('a new plan archives the tour it replaces under tours/, whole; an empty tour is not archived', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    await $.tool.call({ tool: 'mcp__cosight__plan', question: 'Why does the merge gate refuse?', stops: ['One', 'Two'] } as never)
    expect(w.archives).toEqual([])
    const first = lastDoc(w).tourId
    await show($, { stop: 1 })
    await w.clock.advance(10)
    await $.tool.call({ tool: 'mcp__cosight__plan', question: 'How does retry work?', stops: ['A'] } as never)
    expect(w.archives).toHaveLength(1)
    const { path, doc } = w.archives[0]!
    const day = new Date(Number(first.slice(2))).toISOString().slice(0, 10)
    expect(path).toBe(`${WORKDIR}/tours/${day}-why-does-the-merge-gate-refuse-${first}.json`)
    expect(doc).toMatchObject({ tourId: first, question: 'Why does the merge gate refuse?' })
    expect(doc.stops.map(s => s.n)).toEqual([1])
    // The page gets the new tour, under a new id, with nothing of the old one.
    expect(lastDoc(w).tourId).not.toBe(first)
    expect(lastDoc(w)).toMatchObject({ question: 'How does retry work?', stops: [], asides: [] })
    // Replacing the new, still empty tour writes nothing.
    await $.tool.call({ tool: 'mcp__cosight__plan', question: 'Q', stops: ['A'] } as never)
    expect(w.archives).toHaveLength(1)
  })

  test('/tour off archives the tour; a failed archive write leaves the tour going', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    await $.command.run(tour('off'))
    expect(w.archives).toEqual([])
    await $.command.run(tour('on'))
    await $.tool.call({ tool: 'mcp__cosight__plan', question: 'How?', stops: ['One'] } as never)
    await show($, { stop: 1 })
    await $.command.run(tour('off'))
    expect(w.archives).toHaveLength(1)
    expect(w.archives[0]!.path).toMatch(new RegExp(`^${WORKDIR}/tours/\\d{4}-\\d{2}-\\d{2}-how-t-\\d+\\.json$`))
    expect(w.archives[0]!.doc.stops).toHaveLength(1)
    expect(lastDoc(w).phase).toBe('off')

    w.isArchiveBroken = true
    await $.command.run(tour('on'))
    await show($, { stop: 2 })
    const r = await $.tool.call({ tool: 'mcp__cosight__plan', question: 'Next', stops: ['A'] } as never)
    expect(r.isError).not.toBe(true)
    expect(lastDoc(w).question).toBe('Next')
  })

  test('a stop\'s focus rides into tour.json with its own diagram; none, all-empty or no diagram leaves it out', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    const flow = 'flowchart LR\n  gate["Gate"] --> ci["CI"]'
    await show($, { stop: 1, svg: flow, say: 'The gate asks. CI answers. Done.', focus: [' gate ', 'ci', ''] })
    await show($, { stop: 2, svg: flow, focus: ['', ''] })
    await show($, { stop: 3, focus: ['gate'] })
    await show($, { stop: 4, svg: flow })
    const [a, b, c, d] = lastDoc(w).stops
    expect(a!.focus).toEqual(['gate', 'ci', ''])
    expect('focus' in b!).toBe(false)
    expect('focus' in c!).toBe(false)
    expect('focus' in d!).toBe(false)
  })

  test('a plan with no stops is refused', async ($, on) => {
    world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    const r = await $.tool.call({ tool: 'mcp__cosight__plan', question: 'Q', stops: [] } as never)
    expect(r.deny).toContain('at least one stop')
  })

  test('/tour perf <target> asks for the tour in your words and tells the page Claude is reading', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('perf the scheduler'))
    expect(w.submitted).toEqual([])
    await w.clock.advance(1)
    expect(w.submitted).toEqual(['Walk me through the scheduler with a performance focus.'])
    expect(lastDoc(w)).toMatchObject({ phase: 'reading', status: 'Reading the code', tourId: '', plan: [] })
    // Each read Claude makes names itself on the page, once per change.
    await $.tool.call({ tool: 'Read', file_path: '/work/src/sched/loop.ts' } as never)
    expect(lastDoc(w).status).toBe('Reading sched/loop.ts')
    const n = w.docs.length
    await $.tool.call({ tool: 'Read', file_path: '/work/src/sched/loop.ts' } as never)
    expect(w.docs.length).toBe(n)
    await $.tool.call({ tool: 'Grep', pattern: 'tick' } as never)
    expect(lastDoc(w).status).toBe('Searching for tick')
    // Claude answers without ever planning: the page learns it stopped.
    await mainTurnEnds($)
    expect(lastDoc(w)).toMatchObject({ phase: 'done', status: '' })
    // Once planning is over, reads are no longer reported.
    await $.command.run(tour('perf again'))
    await w.clock.advance(1)
    await $.tool.call({ tool: 'mcp__cosight__plan', question: 'Q', stops: ['One', 'Two'] } as never)
    await $.tool.call({ tool: 'Read', file_path: '/work/x.ts' } as never)
    expect(lastDoc(w).status).toBe('Writing stop 1 of 2')
  })

  test('a turn that ends with stops still unwritten says so on the page', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    await $.tool.call({ tool: 'mcp__cosight__plan', question: 'Q', stops: ['One', 'Two', 'Three'] } as never)
    await show($, { stop: 1 })
    await mainTurnEnds($)
    expect(lastDoc(w)).toMatchObject({ phase: 'done', status: 'Claude stopped after stop 1 of 3' })
  })

  test('a question asked on the page mid-tour comes back in the next stop, goes on the status line, and is not sent twice', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    await show($)
    w.requests.push(JSON.stringify({ kind: 'question', text: 'What if the piece is missing?', step: '1', heading: 'The middle' }))
    // A tour turn is running: the poll leaves it for the next stop's result.
    await w.clock.advance(5000)
    expect(w.submitted).toEqual([])
    const r = await show($, { title: 'The end' })
    expect(r.result).toContain('the person asked: "What if the piece is missing?"')
    expect(r.result).toContain('"ask"')
    expect(lastDoc(w).status).toBe('Answering: What if the piece is missing?')
    await mainTurnEnds($)
    await w.clock.advance(5000)
    expect(w.submitted).toEqual([])
  })

  test('once Claude is idle, a page question becomes a prompt and the page says so; old ones and a lone Hold do not', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    // Pressed while the tour was off: not replayed when it is switched on.
    w.requests.push(JSON.stringify({ kind: 'question', text: 'An old one', step: 3 }))
    await $.command.run(tour('on'))
    expect((await show($)).result).not.toContain('An old one')
    await mainTurnEnds($)
    w.requests.push(JSON.stringify({ kind: 'hold', text: '', step: 1 }))
    await w.clock.advance(2000)
    expect(w.submitted).toEqual([])
    w.requests.push(JSON.stringify({ kind: 'question', text: 'Why two locks?', step: 1, heading: 'The middle' }))
    w.requests.push('not json')
    await w.clock.advance(2000)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain('the person asked: "Why two locks?"')
    expect(w.submitted[0]).not.toContain('An old one')
    expect(lastDoc(w)).toMatchObject({ phase: 'answering', status: 'Answering: Why two locks?' })
    await w.clock.advance(4000)
    expect(w.submitted).toHaveLength(1)
    // The answer lands as an aside and the page learns Claude is done with it.
    await show($, { ask: 'Why two locks?', title: 'Two locks' })
    expect(lastDoc(w).phase).toBe('done')
    expect(lastDoc(w).asides).toHaveLength(1)
  })

  test('a reload with the tour on does not replay what was pressed before it', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    await mainTurnEnds($)
    w.requests.push(JSON.stringify({ kind: 'question', text: 'Asked before the reload', step: 9 }))
    // The module loads again: session.start fires again, the tour still on.
    await $.session.start(SESSION)
    await w.clock.advance(4000)
    expect(w.submitted).toEqual([])
    w.requests.push(JSON.stringify({ kind: 'question', text: 'Asked after it', step: 9 }))
    await w.clock.advance(2000)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain('Asked after it')
  })

  test('/tour off clears the status line, tells the page, and stops handing page requests over', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    await $.command.run(tour('off'))
    expect(w.statuses.at(-1)).toBeUndefined()
    expect(lastDoc(w).phase).toBe('off')
    w.requests.push(JSON.stringify({ kind: 'question', text: 'Anyone there?', step: 1 }))
    await w.clock.advance(4000)
    expect(w.submitted).toEqual([])
  })
  // An archived tour as tours/ holds it: `stops` route stops and `asides` answers, started at `ms`.
  const kept = (ms: number, question: string, stops: number, asides: number) => ({
    path: archivePath(WORKDIR, question, `t-${ms}`, ms),
    text: JSON.stringify({
      v: 1, tourId: `t-${ms}`, lens: 'bugs', phase: 'done', status: '', question, plan: [{ n: 1, title: 'One' }],
      stops: Array.from({ length: stops }, (_, i) => ({ id: `s${i}`, n: i + 1, title: `S${i}`, fileUrl: 'files/k-1.txt', highlight: [] })),
      asides: Array.from({ length: asides }, (_, i) => ({ id: `a${i}`, n: 0, ask: `Why ${i}?`, from: 1, title: `A${i}`, fileUrl: 'files/k-1.txt', highlight: [] })),
    }),
  })
  const OCT_19 = Date.UTC(2026, 9, 19, 12)
  const OCT_17 = Date.UTC(2026, 9, 17, 12)

  test('/tour history lists kept tours newest first, the live one too, skips a corrupt file, and starts no tour', async ($, on) => {
    const w = world(on, Date.UTC(2026, 9, 20, 9))
    for (const k of [kept(OCT_17, 'How does retry work?', 3, 0), kept(OCT_19, 'Why does the merge gate refuse a branch that passed every check?', 8, 14)]) w.tours.set(k.path, k.text)
    w.tours.set(`${TOURS}/2026-10-18-broken-t-${OCT_19 - 1}.json`, '{not json')
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    await $.tool.call({ tool: 'mcp__cosight__plan', question: 'What does the poll do?', stops: ['One', 'Two'] } as never)
    await show($, { stop: 1 })
    const docs = w.docs.length
    const r = await $.command.run(tour('history'))
    expect(r.text!.split('\n')).toEqual([
      '1  Oct 20, 2026  What does the poll do?  (1 stop, 0 answers) (on the page)',
      '2  Oct 19, 2026  Why does the merge gate refuse a branch that passed every c…  (8 stops, 14 answers)',
      '3  Oct 17, 2026  How does retry work?  (3 stops, 0 answers)',
      '',
      '/tour history <n> reopens one on the page.',
    ])
    await w.clock.advance(1)
    expect(w.submitted).toEqual([])
    expect(w.docs.length).toBe(docs)
    // Once archived, the live tour is listed once, from its file, without the mark.
    await $.command.run(tour('off'))
    const after = (await $.command.run(tour('history'))).text!.split('\n')
    expect(after[0]).toBe('1  Oct 20, 2026  What does the poll do?  (1 stop, 0 answers)')
    expect(after).toHaveLength(5)
  })

  test('/tour history with nothing kept says so; a bad number gives the range', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    expect((await $.command.run(tour('history'))).text).toContain('no tours kept yet')
    expect((await $.command.run(tour('history 1'))).text).toContain('no tours kept yet')
    const k = kept(OCT_17, 'How?', 1, 0)
    w.tours.set(k.path, k.text)
    for (const bad of ['history 2', 'history 0', 'history x', 'history 1.5']) {
      expect((await $.command.run(tour(bad))).text).toBe('CoSight: pick a tour from 1 to 1; /tour history lists them.')
    }
    expect(w.submitted).toEqual([])
    // More words after history are a question about history, toured as ever.
    await $.command.run(tour('history of the merge gate'))
    await w.clock.advance(1)
    expect(w.submitted).toEqual(['Walk me through history of the merge gate.'])
  })

  test('/tour history <n> archives the current tour and reopens the kept one whole, under its own id; a page question then lands as an aside', async ($, on) => {
    const w = world(on, OCT_17)
    await $.session.start(SESSION)
    await $.command.run(tour('on'))
    await $.tool.call({ tool: 'mcp__cosight__plan', question: 'First tour', stops: ['One', 'Two'] } as never)
    const first = lastDoc(w)
    await show($, { stop: 1, highlight: [{ from: 2, to: 3 }], svg: 'flowchart LR\n a --> b', focus: ['a'], node: 'api' })
    w.requests.push(JSON.stringify({ kind: 'question', text: 'Why two locks?', step: 1 }))
    await show($, { stop: 2 })
    await show($, { ask: 'Why two locks?', title: 'Two locks' })
    await mainTurnEnds($)
    await w.clock.advance(10)
    await $.tool.call({ tool: 'mcp__cosight__plan', question: 'Second tour', stops: ['A'] } as never)
    await show($, { stop: 1 })
    await mainTurnEnds($)
    expect(w.archives.map(a => a.doc.question)).toEqual(['First tour'])

    const r = await $.command.run(tour('history 2'))
    expect(r.text).toBe(`Reopened "First tour" at ${URL}`)
    // The tour it replaced is kept first.
    expect(w.archives.map(a => a.doc.question)).toEqual(['First tour', 'Second tour'])
    const doc = lastDoc(w)
    expect(doc).toMatchObject({ tourId: first.tourId, question: 'First tour', phase: 'done', status: '', lens: 'general' })
    expect(doc.plan).toEqual([{ n: 1, title: 'One' }, { n: 2, title: 'Two' }])
    expect(doc.stops.map(s => s.n)).toEqual([1, 2])
    expect(doc.stops[0]).toMatchObject({ highlight: [2, 3], focus: ['a'], node: 'api', fileUrl: w.archives[0]!.doc.stops[0]!.fileUrl })
    expect(doc.asides).toEqual(w.archives[0]!.doc.asides)
    expect(doc.asides[0]).toMatchObject({ ask: 'Why two locks?', from: 2 })
    expect(w.submitted).toEqual([])

    // A question asked on the reopened tour's page reaches Claude and its answer is an aside.
    w.requests.push(JSON.stringify({ kind: 'question', text: 'And the third lock?', step: 2 }))
    await w.clock.advance(2000)
    expect(w.submitted).toHaveLength(1)
    expect((await show($, { ask: 'And the third lock?', title: 'Third' })).deny).toBeUndefined()
    expect(lastDoc(w).asides.map(a => a.from)).toEqual([2, 2])
    expect(lastDoc(w).tourId).toBe(first.tourId)
  })

  test('/tour history <n> cleanly replaces a tour still reading with no stops, and switches a tour that is off back on', async ($, on) => {
    const w = world(on, OCT_19)
    const k = kept(OCT_17, 'How does retry work?', 2, 1)
    w.tours.set(k.path, k.text)
    await $.session.start(SESSION)
    // `/tour show history` once started a tour of "show history": reading, nothing shown.
    await $.command.run(tour('show history'))
    expect(lastDoc(w)).toMatchObject({ phase: 'reading', question: '' })
    expect((await $.command.run(tour('history'))).text!.split('\n')).toHaveLength(3)
    expect((await $.command.run(tour('history 1'))).text).toBe(`Reopened "How does retry work?" at ${URL}`)
    expect(w.archives).toEqual([])
    expect(lastDoc(w)).toMatchObject({ tourId: `t-${OCT_17}`, question: 'How does retry work?', phase: 'done', status: '', lens: 'bugs' })
    expect(lastDoc(w).asides).toHaveLength(1)
    // The reading turn ending later leaves the reopened tour alone.
    await mainTurnEnds($)
    expect(lastDoc(w)).toMatchObject({ phase: 'done', status: '' })

    await $.command.run(tour('off'))
    expect(w.statuses.at(-1)).toBeUndefined()
    await $.command.run(tour('history 1'))
    expect(w.statuses.at(-1)).toBe(`cosight: ${URL}`)
    expect(lastDoc(w)).toMatchObject({ phase: 'done', question: 'How does retry work?' })
  })
})
