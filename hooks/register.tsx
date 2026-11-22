// cosight: Claude takes you through code stop by stop, on a web page. Each
// stop shows a whole file scrolled to the lines under discussion, beside a
// flow diagram, and is read aloud by the page while it is on screen. You type
// on the page or in the terminal; Claude talks.
//
// How it fits together:
//   /tour [lens] <target>  switches the tour on and asks Claude to tour
//                          through the target (lens: perf, impl, bugs).
//   /tour on|off           switches it on (the page up, waiting for your
//                          question) or off. Off by default.
//   /tour history [n]      lists the kept tours (tours/ below) newest first, in the terminal;
//                          with n, reopens that one on the page under its own tourId, so the
//                          page brings back its Export order and ticks. No prompt goes to Claude.
//   /tour quiet|voice      pushes mute on or off to the page; the page's own
//                          speaker button wins after that. /tour speed <x>
//                          pushes the voice speed the same way.
//   prompt.compose         while on, tells Claude how to tour: a plan, then one
//                          tool call per stop, one straight after another.
//   mcp__cosight__plan   the route, then mcp__cosight__show once per stop.
//                          Registered the first time a tour is switched on, so
//                          a session that never tours carries no extra tool.
//   tour.json              the whole tour, written on every change to the page's
//                          working directory: the phase Claude is in, the plan,
//                          every stop and aside. assets/tour-server.js watches it,
//                          adds a spoken mp3 per stop (Kokoro) and pushes it to
//                          assets/index.html over server-sent events. The terminal
//                          shows only the page's URL.
//   files/<key>.txt        each file a stop shows, whole, so the page can scroll
//                          all of it rather than an excerpt.
//   overviews/<key>.json   the project's overview diagram (a Mermaid flowchart of
//                          the whole project), drawn by Claude in its first plan of
//                          the project and reused by every later tour of it; each
//                          stop names the box it lives in, so the page can zoom to it.
//   tours/<date>-<slug>-<id>.json
//                          a copy of each tour a new one replaced or /tour off ended, kept
//                          for the person; /tour history lists them and reopens one.
//   requests.jsonl         what the person presses on the page: a question (typed,
//                          or about a diagram box they clicked), Hold. Read back
//                          here and handed to Claude: in the next plan/show result
//                          while a tour turn runs, or as a prompt once Claude is idle.
//
// Nothing waits on speech. A show call returns at once; the page shows stop 1
// the moment it lands, plays it, and moves on as later stops arrive. While
// Claude is still reading the code, every tool call it makes puts one line on
// the page ("Reading hooks/tour.ts"), so the page is never blank.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { DEFAULT_HOST, DEFAULT_PORT, FILES_REL, TOURS_REL, WORKDIR_REL, archiveMs, archivePath, canvasUrl, fileKey, overviewPath, parseArchive, parseOverview, restoreOf, tourDoc } from './canvas'
import type { Lens, Overview, PageAsk, PageRequest, Phase, Route, Stop, TourDoc } from '../types'
import { HISTORY_MAX, INPUT_SCHEMA, PLAN_SCHEMA, PLAN_TOOL, TOOL, askFor, claimAsk, clampRange, focusOf, historyText, overviewOf, pageRequestsText, parseTour, promptFor, rangesOf, readingStatus, requestsOf, routeOf, spoken } from './tour'
import type { HistoryEntry } from './tour'

const KEEP = 60
/**
 * The tour's own tools, matched by pattern: they are registered at run time, so the laid types
 * never list their names and a literal would not type-check.
 */
const PLAN_MATCH = new RegExp(`^${PLAN_TOOL}$`)
const SHOW_MATCH = new RegExp(`^${TOOL}$`)
/** How often the page's requests are looked at while Claude is idle. */
const POLL_MS = 1500

const isOn = atom({ plugin: 'cosight', key: 'isOn' } as const, false)
const isQuiet = atom({ plugin: 'cosight', key: 'isQuiet' } as const, false)
const muteVersion = atom({ plugin: 'cosight', key: 'muteVersion' } as const, 0)
const speed = atom({ plugin: 'cosight', key: 'speed' } as const, 1)
const speedVersion = atom({ plugin: 'cosight', key: 'speedVersion' } as const, 0)
const lens = atom({ plugin: 'cosight', key: 'lens' } as const, 'general' as Lens)
const stops = atom({ plugin: 'cosight', key: 'stops' } as const, [] as Stop[])
const hasTool = atom({ plugin: 'cosight', key: 'hasTool' } as const, false)
const route = atom({ plugin: 'cosight', key: 'route' } as const, { question: '', stops: [] } as Route)
/** True once this session has tried to bring the browser canvas up. */
const canvasReady = atom({ plugin: 'cosight', key: 'canvasReady' } as const, false)
/** The canvas's resolved URL; set once canvasReady is true. */
const canvasUrlState = atom({ plugin: 'cosight', key: 'canvasUrl' } as const, '')
/** tour.json's `v`; must increase on every write. */
const canvasVersion = atom({ plugin: 'cosight', key: 'canvasVersion' } as const, 0)
/** Lines of requests.jsonl already handed to Claude or passed over. */
const requestsSeen = atom({ plugin: 'cosight', key: 'requestsSeen' } as const, 0)
const phase = atom({ plugin: 'cosight', key: 'phase' } as const, 'off' as Phase)
const status = atom({ plugin: 'cosight', key: 'status' } as const, '')
const tourId = atom({ plugin: 'cosight', key: 'tourId' } as const, '')
/** The current project's overview diagram, from its cache file or the last plan; null when none. */
const overview = atom({ plugin: 'cosight', key: 'overview' } as const, null as Overview | null)
/** The page's questions handed to Claude; an aside is accepted only against one of these. */
const pageAsks = atom({ plugin: 'cosight', key: 'pageAsks' } as const, [] as PageAsk[])

/**
 * True from a plan or show call until the main loop's turn ends. While it holds, the page's
 * requests wait for the next plan or show result, which Claude reads between stops; a prompt
 * submitted now would only queue behind the whole tour. Module state: a reload clears it, and
 * the poll then hands requests over as a prompt, which the engine runs once Claude is idle.
 */
let isTourTurn = false
/** True while one poll of the page's requests is under way, so two never overlap. */
let isPolling = false

/** HOME, for the canvas's working directory and ~ in a path. */
const home = async ($: EngineInterface) => (await $.env.get('HOME')) ?? ''

const workdir = async ($: EngineInterface) => (await $.env.get('COSIGHT_DATA_DIR')) || `${await home($)}/${WORKDIR_REL}`
const requestsPath = async ($: EngineInterface) => `${await workdir($)}/requests.jsonl`

/** The page's requests since the last look, marked seen. None when the file is missing. */
async function takeRequests($: EngineInterface): Promise<PageRequest[]> {
  let text: string
  try {
    text = await $.fs.read(await requestsPath($))
  } catch {
    return []
  }
  const { requests, total } = requestsOf(text, await read($, requestsSeen))
  await update($, requestsSeen, () => total)
  const project = await $.session.cwd()
  return requests.filter(r => !r.project || r.project === project)
}

/** Project instructions are read on every prompt, so saving in the app takes effect immediately. */
async function savedInstructions($: EngineInterface): Promise<string> {
  try {
    const project = await $.session.cwd()
    // Same SHA-256 key as the server, supplied through a small per-project index below.
    const presets = JSON.parse(await $.fs.read(`${await workdir($)}/project-instructions.json`))
    const instructions = presets[project]
    return typeof instructions === 'string' && instructions.trim() ? `\nSaved instructions for this project:\n${instructions}` : ''
  } catch { return '' }
}

/** Where the current project's overview is cached: overviews/<fileKey(cwd)>.json. */
async function overviewFile($: EngineInterface): Promise<string> {
  return overviewPath(await workdir($), fileKey(await $.session.cwd()))
}

/** The current project's cached overview, or null when the file is missing or not an overview. */
async function readOverview($: EngineInterface): Promise<Overview | null> {
  try {
    return parseOverview(await $.fs.read(await overviewFile($)))
  } catch {
    return null
  }
}

/** Keeps a freshly drawn overview: in the atom, and on disk for every later tour of this project. */
async function keepOverview($: EngineInterface, next: Overview) {
  await update($, overview, () => next)
  try {
    await $.fs.write(await overviewFile($), JSON.stringify({ project: await $.session.cwd(), ...next }))
  } catch {
    // This tour still has it; only later tours lose the cache.
  }
}

/** The whole tour as tour.json carries it, at version `v`. */
async function docOf($: EngineInterface, v: number) {
  const project = await $.session.cwd()
  return tourDoc(
    {
      v,
      tourId: await read($, tourId),
      lens: await read($, lens),
      phase: await read($, phase),
      status: await read($, status),
      mute: { v: await read($, muteVersion), on: await read($, isQuiet) },
      speed: { v: await read($, speedVersion), rate: await read($, speed) },
      project,
      projectKey: fileKey(project),
      overview: await read($, overview),
    },
    await read($, route),
    await read($, stops),
  )
}

/** Writes the whole tour.json for the server to pick up and push to the page. */
async function pushDoc($: EngineInterface) {
  const v = (await read($, canvasVersion)) + 1
  await update($, canvasVersion, () => v)
  const doc = await docOf($, v)
  try {
    await $.fs.write(`${await workdir($)}/tour.json`, JSON.stringify(doc))
  } catch {
    // A write failure costs this one update on the page; the tour itself goes on.
  }
}

/**
 * Keeps a copy of the current tour under tours/ before it is replaced or switched off, so a
 * tour a new question pushed off the page is not lost. A tour with no stop shown is not worth a
 * file. One write of the whole text, built first: the file is all there or not there, and a
 * failure costs only the copy, never the tour.
 */
async function archiveTour($: EngineInterface) {
  if ((await read($, stops)).length === 0) return
  try {
    const now = await $.clock.now()
    const doc = await docOf($, await read($, canvasVersion))
    await $.fs.write(archivePath(await workdir($), doc.question, doc.tourId, now), JSON.stringify(doc))
  } catch {
    // The live tour is unaffected; only the record is missing.
  }
}

/** One /tour history line and the tour it stands for. */
type Kept = HistoryEntry & { doc: TourDoc }

const LENSES: readonly Lens[] = ['general', 'performance', 'implementation', 'bugs']

/**
 * The kept tours, newest first, at most HISTORY_MAX: the archive files under tours/ (ordered by
 * the start time in their names, so only the ones listed are opened; a corrupt or unreadable one
 * is passed over), plus the live tour when it has stops and no archive holds it yet, so the
 * newest tour is never missing from the list.
 */
async function keptTours($: EngineInterface): Promise<Kept[]> {
  const dir = `${await workdir($)}/${TOURS_REL}`
  const files = await $.fs.list(dir).catch(() => [])
  const named = files
    .filter(f => f.kind === 'file' && f.name.endsWith('.json'))
    .map(f => ({ path: `${dir}/${f.name}`, ms: archiveMs(f.name) ?? f.mtimeMs }))
    .sort((a, b) => b.ms - a.ms)
  const kept: Kept[] = []
  for (const f of named) {
    if (kept.length >= HISTORY_MAX) break
    const doc = await $.fs.read(f.path).then(parseArchive, () => null)
    if (doc && doc.project === await $.session.cwd()) kept.push({ doc, ms: f.ms, question: doc.question, stops: doc.stops.length, answers: doc.asides.length, isLive: false })
  }
  const id = await read($, tourId)
  const list = await read($, stops)
  if (list.length && !(id && kept.some(k => k.doc.tourId === id))) {
    const doc = await docOf($, await read($, canvasVersion))
    // A tour's id is `t-<ms of its plan>`; one shown without a plan has none and counts as now.
    const m = /^t-(\d+)$/.exec(id)
    const ms = m ? Number(m[1]) : await $.clock.now()
    kept.push({ doc, ms, question: doc.question, stops: doc.stops.length, answers: doc.asides.length, isLive: true })
  }
  return kept.sort((a, b) => b.ms - a.ms).slice(0, HISTORY_MAX)
}

/**
 * Puts a kept tour back on the page: the current one archived first (an empty one is not), then
 * the kept route, stops and asides, its own tourId (the page keys Export order and ticks by it)
 * and lens, the phase done. Whatever was under way (a "reading" with no stops) is replaced whole.
 */
async function reopenTour($: EngineInterface, doc: TourDoc): Promise<string> {
  await archiveTour($)
  const kept = restoreOf(doc)
  await update($, route, () => kept.route)
  await update($, stops, () => kept.stops)
  await update($, tourId, () => doc.tourId)
  if (LENSES.includes(doc.lens as Lens)) await update($, lens, () => doc.lens as Lens)
  // The phase first, so switchOn does not push an idle page in between.
  await update($, phase, () => 'done')
  const url = (await read($, isOn)) ? await ensureCanvas($) : await switchOn($)
  await setPhase($, 'done')
  return url
}

/** The page's questions among `requests` are remembered as handed over, so their answers may be asides. */
async function noteAsks($: EngineInterface, requests: readonly PageRequest[]) {
  const asked = requests.flatMap(r => (r.kind === 'question' && r.text ? [{ text: r.text, isAnswered: false }] : []))
  if (asked.length) await update($, pageAsks, list => [...list, ...asked].slice(-KEEP))
}

/** Sets where Claude is and what the page says about it, and pushes the document. */
async function setPhase($: EngineInterface, next: Phase, line = '') {
  await update($, phase, () => next)
  await update($, status, () => line)
  await pushDoc($)
}

/** Hands the page's requests to an idle Claude as a prompt of their own; called every POLL_MS. */
async function pollPage($: EngineInterface) {
  if (isPolling || isTourTurn || !(await read($, isOn))) return
  isPolling = true
  try {
    const requests = await takeRequests($)
    const text = pageRequestsText(requests, true)
    await noteAsks($, requests)
    if (text) {
      await setPhase($, 'answering', answeringLine(requests))
      // Resolves when that turn starts, so at most one such prompt waits at a time.
      await $.prompt.submit({ text }).catch(() => undefined)
    }
  } finally {
    isPolling = false
  }
}

/** The page's status line while a question from it is with Claude. */
function answeringLine(requests: readonly PageRequest[]): string {
  const q = requests.findLast(r => r.kind === 'question' && r.text)
  return q ? `Answering: ${q.text.length > 70 ? `${q.text.slice(0, 67)}...` : q.text}` : 'Answering'
}

/**
 * Starts the canvas server (start-canvas.sh is idempotent: "already up" when it answers) and
 * returns its URL whether or not the start worked; a failed start never blocks the tour.
 */
async function startCanvas($: EngineInterface): Promise<string> {
  const port = Number(await $.env.get('COSIGHT_PORT')) || DEFAULT_PORT
  const host = (await $.env.get('COSIGHT_HOST'))?.trim() || DEFAULT_HOST
  const url = canvasUrl(port, host)
  const script = `${$.plugin.root}/assets/start-canvas.sh`
  if (await $.fs.exists(script)) {
    try {
      await $.process.run(['bash', script, await workdir($), String(port), host], { timeoutMs: 15000 })
    } catch {
      // Best effort: the server may already be held by another host or node may be missing.
    }
  }
  await update($, canvasReady, () => true)
  await update($, canvasUrlState, () => url)
  return url
}

/** The canvas's URL, starting it first when this session has not yet. */
async function ensureCanvas($: EngineInterface): Promise<string> {
  if (await read($, canvasReady)) return (await read($, canvasUrlState)) || startCanvas($)
  return startCanvas($)
}

/** Switches the tour on: the tools registered once, the page up, its URL on the status line. */
async function switchOn($: EngineInterface): Promise<string> {
  if (!(await read($, isOn))) {
    // What was pressed on the page before this tour (a question nobody read) is not replayed,
    // and nothing asked before it may still claim an aside.
    await takeRequests($)
    await update($, pageAsks, () => [])
  }
  await update($, isOn, () => true)
  if (!(await read($, hasTool))) {
    await $.tool.register({
      name: 'plan',
      description:
        'CoSight: set the question the tour answers and the titles of its stops, in order, before the first stop. ' +
        'Starts a new tour: the page clears and shows the route, every stop greyed until it is shown.',
      inputSchema: PLAN_SCHEMA,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'show',
      description:
        'CoSight: show one stop on the web page: the whole file scrolled to the range, the lines under ' +
        'discussion highlighted, its diagram beside them, and the "say" text read aloud by the page. Returns at once.',
      inputSchema: INPUT_SCHEMA,
      isDeferred: false,
    })
    await update($, hasTool, () => true)
  }
  // The project's overview, if an earlier tour drew one: the ask shows it to Claude.
  const cached = await readOverview($)
  await update($, overview, () => cached)
  const url = await startCanvas($)
  if ((await read($, phase)) === 'off') await setPhase($, 'idle')
  $.ui.status(`cosight: ${url}`)
  return url
}

/** A path from the tool input made absolute: ~ expanded, a relative one under the session's directory. */
async function absolute($: EngineInterface, file: string) {
  if (file.startsWith('~/')) return `${await home($)}/${file.slice(2)}`
  if (file.startsWith('/')) return file
  return `${await $.session.cwd()}/${file}`
}

function relative(cwd: string, path: string) {
  const root = cwd.endsWith('/') ? cwd : cwd + '/'
  return path.startsWith(root) ? path.slice(root.length) : path
}

/** The highest route stop number shown so far. */
const lastStop = (list: readonly Stop[]) => list.reduce((m, s) => (s.ask ? m : Math.max(m, s.n)), 0)

/**
 * A tool result with whatever the person pressed on the page since the last look, if anything;
 * a question among them goes on the page's status line too, so they see it was taken.
 */
async function withRequests($: EngineInterface, result: string) {
  const requests = await takeRequests($)
  const asks = pageRequestsText(requests, false)
  await noteAsks($, requests)
  if (requests.some(r => r.kind === 'question' && r.text)) {
    await update($, status, () => answeringLine(requests))
    await pushDoc($)
  }
  return asks ? `${result}\n${asks}` : result
}

/** Starts a new tour: the old one archived, the route set, the stops cleared. */
async function newTour($: EngineInterface, next: Route) {
  await archiveTour($)
  await update($, route, () => next)
  await update($, stops, () => [])
}

/** Writes a file's whole text under files/ once per content, and returns its key. */
async function storeFile($: EngineInterface, text: string): Promise<string> {
  const key = fileKey(text)
  const path = `${await workdir($)}/${FILES_REL}/${key}.txt`
  try {
    if (!(await $.fs.exists(path))) await $.fs.write(path, text)
  } catch {
    // The page then shows the stop without its file; the tour goes on.
  }
  return key
}

/** "Writing stop n of m", or what the page says once every planned stop is in. */
function writingLine(next: number, total: number): string {
  return next <= total ? `Writing stop ${next} of ${total}` : 'All stops written'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tour',
      description: 'Ask for a guided tour of code, spoken, on a web page: /tour [perf|impl|bugs] <question, file or topic> | on | off | history [n] | quiet | voice',
    })
    // A fresh session, or this module reloaded mid-session: what is already in requests.jsonl
    // was pressed before now and is not handed over (it holds every earlier tour's presses).
    await takeRequests($)
    // One poll for the module's life; it does nothing while the tour is off.
    $.clock.every(POLL_MS, () => void pollPage($).catch(() => undefined))
    if (await read($, isOn)) $.ui.status(`cosight: ${await ensureCanvas($)}`)
    return next(e)
  })

  // The main loop's turn is over: requests that arrived after its last stop go out as a prompt,
  // and the page learns Claude has stopped (so "Writing stop 4 of 9" never sits there forever).
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      isTourTurn = false
      if (await read($, isOn)) {
        const p = await read($, phase)
        if (p === 'reading' || p === 'writing' || p === 'answering') {
          const planned = (await read($, route)).stops.length
          const shown = lastStop(await read($, stops))
          await setPhase($, 'done', planned && shown < planned ? `Claude stopped after stop ${shown} of ${planned}` : '')
        }
      }
    }
    return next(e)
  })

  // While Claude reads the code before a plan, or works on a page question, each tool call it
  // makes becomes one line on the page's progress card. Never answers; never refuses.
  on('tool.call', async ($, e, next) => {
    if (await read($, isOn)) {
      const p = await read($, phase)
      if (p === 'reading' || p === 'answering') {
        const line = readingStatus(e.tool, e as unknown as Record<string, unknown>)
        if (line && line !== (await read($, status))) {
          await update($, status, () => line)
          await pushDoc($)
        }
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'tour' }, async ($, e) => {
    const w = parseTour(e.args)
    if (w.action === 'off') {
      if (await read($, isOn)) await archiveTour($)
      await update($, isOn, () => false)
      await setPhase($, 'off')
      $.ui.status(undefined)
      return { text: 'CoSight off.' }
    }
    if (w.action === 'history') {
      const kept = await keptTours($)
      if (w.n === null) return { text: historyText(kept) }
      const pick = kept[w.n - 1]
      if (!Number.isInteger(w.n) || !pick) {
        return { text: kept.length ? `CoSight: pick a tour from 1 to ${kept.length}; /tour history lists them.` : historyText(kept) }
      }
      const url = await reopenTour($, pick.doc)
      return { text: `Reopened "${pick.question}" at ${url}` }
    }
    if (w.action === 'speed') {
      if (w.rate === null) return { text: 'CoSight: give a speed from 0.6 to 2, e.g. /tour speed 1.2.' }
      await update($, speed, () => w.rate!)
      await update($, speedVersion, n => n + 1)
      await pushDoc($)
      return { text: `CoSight: the page speaks at ${w.rate}x.` }
    }
    if (w.action === 'quiet' || w.action === 'voice') {
      await update($, isQuiet, () => w.action === 'quiet')
      await update($, muteVersion, n => n + 1)
      await pushDoc($)
      return { text: w.action === 'quiet' ? 'CoSight: the page is muted.' : 'CoSight: the page speaks again.' }
    }
    if (w.action === 'start' && w.lens) await update($, lens, () => w.lens!)
    const url = await switchOn($)
    if (w.action === 'start' && w.target) {
      await newTour($, { question: '', stops: [] })
      await update($, tourId, () => '')
      await setPhase($, 'reading', 'Reading the code')
      // A command.run hook may not submit: the submission would wait on the
      // turn this hook holds. Submit once the command has returned.
      const text = promptFor(await read($, lens), w.target)
      $.clock.after(0, () => void $.prompt.submit({ text, asUser: true }).catch(() => undefined))
      return { text: `CoSight on (${await read($, lens)}). Follow it at ${url}` }
    }
    return { text: `CoSight on (${await read($, lens)}): ${url}\nAsk about any code, or /tour perf|impl|bugs <question, file or topic>; /tour history lists earlier tours.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!(await read($, isOn))) return r
    return { sections: [...r.sections, { id: 'cosight:ask', text: askFor(await read($, lens), await read($, overview)) + await savedInstructions($), scope: 'session' as const }] }
  })

  // The plan: the question and the route, before the first stop.
  on('tool.call', { tool: PLAN_MATCH }, async ($, e) => {
    if (!(await read($, isOn))) return { deny: 'CoSight is off. The person can switch it on with /tour on.' }
    const next = routeOf(e as unknown as Record<string, unknown>)
    if (!next.question || next.stops.length === 0) return { deny: 'Give "question" and at least one stop title.' }
    isTourTurn = true
    await newTour($, next)
    const now = await $.clock.now()
    await update($, tourId, () => `t-${now}`)
    // A plan that draws the project overview replaces the cached one, for this tour and every
    // later one of this project; a plan without one keeps what is cached (looked up again here,
    // in case another session drew it since the tour was switched on).
    const drawn = overviewOf(e as unknown as Record<string, unknown>)
    if (drawn) await keepOverview($, { ...drawn, written: now })
    else if (!(await read($, overview))) {
      const cached = await readOverview($)
      await update($, overview, () => cached)
    }
    const url = await ensureCanvas($)
    await setPhase($, 'writing', writingLine(1, next.stops.length))
    return {
      result: await withRequests(
        $,
        `Planned ${next.stops.length} stops. Now show stop 1, then each next stop straight after. The person follows it at ${url}`,
      ),
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'CoSight could not set the plan.' }))

  // One stop. Answered here; nothing beneath runs.
  on('tool.call', { tool: SHOW_MATCH }, async ($, e) => {
    if (!(await read($, isOn))) return { deny: 'CoSight is off. The person can switch it on with /tour on.' }
    const input = e as unknown as Record<string, unknown>
    const file = String(input.file ?? '')
    if (!file) return { deny: 'Give "file", "start", "end" and "say".' }
    const ask = String(input.ask ?? '').trim()
    // An aside answers a question asked on the page, and nothing else: a terminal reply shown as
    // one buried a whole tour under the rest of the session.
    const claimed = ask ? claimAsk(await read($, pageAsks), ask) : null
    if (ask && !claimed) {
      return {
        deny:
          'Not shown: an aside ("ask") answers a question asked on the tour page, and none is waiting. ' +
          'Answer what the person says in the terminal in the terminal, in your reply. If they asked a new ' +
          `question about how code works, call ${PLAN_TOOL} to start a new tour.`,
      }
    }
    isTourTurn = true

    const path = await absolute($, file)
    let text: string
    try {
      text = await $.fs.read(path)
    } catch {
      return { deny: `Cannot read ${path}.` }
    }
    const lines = text.split('\n')
    const { start, end } = clampRange(Number(input.start), Number(input.end), lines.length)
    const list = await read($, stops)
    if (claimed) await update($, pageAsks, () => claimed)
    const asked = Number(input.stop)

    const stop: Stop = {
      id: e.tool_use_id,
      file: relative(await $.session.cwd(), path),
      fileKey: await storeFile($, text),
      fileLines: lines.length,
      start,
      end,
      highlight: rangesOf(input.highlight),
      title: String(input.title ?? ''),
      say: spoken(String(input.say ?? '')),
      note: String(input.note ?? ''),
      ask,
      // An aside belongs to the newest route stop shown; a route stop takes its own number,
      // or the next one when it gives none.
      from: ask ? lastStop(list) : 0,
      n: ask ? 0 : Number.isSafeInteger(asked) && asked > 0 ? asked : lastStop(list) + 1,
      svg: String(input.svg ?? ''),
      diagramCaption: String(input.diagramCaption ?? ''),
      diagramWhy: String(input.diagramWhy ?? ''),
      codeWhy: String(input.codeWhy ?? ''),
      mode: String(input.mode ?? ''),
      node: String(input.node ?? '').trim(),
      focus: focusOf(input.focus),
    }
    // A route stop shown again replaces its earlier showing; asides accumulate.
    const updated = [...list.filter(s => s.ask || s.n !== stop.n), stop].slice(-KEEP)
    await update($, stops, () => updated)

    const url = await ensureCanvas($)
    const planned = await read($, route)
    const total = Math.max(planned.stops.length, lastStop(updated))
    // An aside mid-tour leaves the phase alone; a route stop says which one is next.
    if (stop.ask) {
      const p = await read($, phase)
      await update($, status, () => (p === 'writing' ? writingLine(lastStop(updated) + 1, total) : ''))
      if (p === 'answering') await update($, phase, () => 'done')
      await pushDoc($)
    } else {
      await setPhase($, 'writing', writingLine(stop.n + 1, total))
    }

    return {
      result: await withRequests(
        $,
        `Shown ${stop.file} lines ${start}-${end}${stop.ask ? ' as an aside' : ` as stop ${stop.n}`}. ` +
          `The page is reading it out at ${url}${!stop.ask && stop.n < total ? `; show stop ${stop.n + 1} now` : ''}.`,
      ),
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'CoSight could not show this stop.' }))
}
