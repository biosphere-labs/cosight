// cosight: the pure half of the browser canvas, the tour's only view (the
// terminal shows just its URL). Nothing here touches `$`; register.tsx starts
// the server and writes what this module builds.
//
// The mod writes one whole document, tour.json, on every change: the phase
// Claude is in, the plan, every delivered stop and every aside. The server
// (assets/tour-server.js) watches that file, adds a spoken mp3 per stop, and
// pushes the result to the page over server-sent events. The page keeps no
// state of its own that the document does not carry, so a reload, a tab left
// and come back to, or a browser opened late all show the same tour.
//
// Why a file and not an HTTP push: the mod and the server share a filesystem,
// and a file the server watches survives the server restarting; a push would
// be lost. The schema is the one tour-server.js and index.html read.

import { langOf } from './gapstyle'
import type { Overview, Phase, Range, Route, Stop, StopDoc, TourDoc } from '../types'

/** The canvas server's default port; overridable with COSIGHT_PORT. */
export const DEFAULT_PORT = 8099

/** Working directory for the canvas, relative to $HOME (matches the archived skill's WSL column). */
export const WORKDIR_REL = '.local/share/cosight'

/** Where whole source files go, under WORKDIR_REL, so the page can show all of a file. */
export const FILES_REL = 'files'

/**
 * Where each project's overview diagram is kept, under WORKDIR_REL: one JSON file per project
 * directory, `{ project, src, caption, written }`, reused by every later tour of that project.
 */
export const OVERVIEWS_REL = 'overviews'

/**
 * Where replaced and switched-off tours are kept, under WORKDIR_REL, one whole tour.json each.
 * They are a record for the person, so a tour that a new question pushed off the page is not
 * simply gone: /tour history lists them and puts one back on the page.
 */
export const TOURS_REL = 'tours'

/**
 * A tour's archive file: `<workdir>/tours/<YYYY-MM-DD>-<slug of question>-<tourId>.json`. The
 * date is the tour's own (its id is `t-<ms>`) when the id carries one, so archiving the same
 * tour twice, at off and again when it is replaced, writes the same file rather than two.
 */
export function archivePath(workdir: string, question: string, tourId: string, now: number): string {
  const ms = Number(/^t-(\d+)$/.exec(tourId)?.[1] ?? now)
  const date = new Date(ms).toISOString().slice(0, 10)
  const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '') || 'tour'
  return `${workdir}/${TOURS_REL}/${date}-${slug}-${tourId || `t-${now}`}.json`
}

/**
 * The address the canvas server listens on and the page's URL names; overridable with
 * COSIGHT_HOST, e.g. a Tailscale address so a session on another machine is watched from here.
 */
export const DEFAULT_HOST = '127.0.0.1'

export function canvasUrl(port: number, host: string = DEFAULT_HOST): string {
  return `http://${host}:${port}/`
}

/** The cache file for a project's overview: `<workdir>/overviews/<projectKey>.json`. */
export function overviewPath(workdir: string, projectKey: string): string {
  return `${workdir}/${OVERVIEWS_REL}/${projectKey}.json`
}

/**
 * The overview a cache file holds, or null when the text is not one (missing fields, a stray
 * write, not JSON at all): a bad cache is treated as no cache, never as an error.
 */
export function parseOverview(text: string): Overview | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>
    const src = typeof o?.src === 'string' ? o.src.trim() : ''
    const written = Number(o?.written)
    if (!src || !Number.isFinite(written)) return null
    return { src, caption: typeof o.caption === 'string' ? o.caption : '', written }
  } catch {
    return null
  }
}

/** Absolute file line numbers covered by a stop's highlight ranges, deduped and sorted. */
export function expandHighlight(ranges: readonly Range[]): number[] {
  const out = new Set<number>()
  for (const r of ranges) for (let n = r.from; n <= r.to; n++) out.add(n)
  return [...out].sort((a, b) => a - b)
}

/**
 * The name a file's text is stored under: FNV-1a over the text plus its length, so the same
 * content is written once and a changed file gets a new name (the hooks runtime has no crypto).
 */
export function fileKey(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16).padStart(8, '0')}-${text.length}`
}

/** The route as the document's `plan` field: `{ n, title }[]`. */
function planOf(route: Route) {
  return route.stops.map((title, i) => ({ n: i + 1, title }))
}

/**
 * One stop as the page reads it: the whole file by URL, the range, the lines, the diagram, the
 * overview box it lives in (`node`, left out when the stop named none), and the box in its own
 * diagram each spoken sentence is about (`focus`, left out when it says nothing).
 */
function stopDoc(s: Stop): StopDoc {
  return {
    ...(s.node ? { node: s.node } : {}),
    // Pointers into this stop's own diagram; nothing to point into without one, and a list of
    // nothing but '' says nothing, so both are left out rather than sent empty.
    ...(s.svg && s.focus.some(Boolean) ? { focus: s.focus } : {}),
    id: s.id,
    n: s.n,
    title: s.title,
    say: s.say,
    note: s.note,
    file: s.file,
    fileUrl: `${FILES_REL}/${s.fileKey}.txt`,
    fileLines: s.fileLines,
    lang: langOf(s.file),
    start: s.start,
    end: s.end,
    highlight: expandHighlight(s.highlight),
    svg: s.svg,
    diagramCaption: s.diagramCaption,
    diagramWhy: s.diagramWhy,
    codeWhy: s.codeWhy,
    mode: s.mode,
  }
}

/** What the document carries beside the stops. */
export type DocHead = {
  v: number
  tourId: string
  lens: string
  phase: Phase
  status: string
  mute: { v: number; on: boolean }
  speed: { v: number; rate: number }
  /** The session's working directory, absolute, and its fileKey: the project the tour is of. */
  project: string
  projectKey: string
  /** The project's overview diagram, or null when none has been drawn yet. */
  overview: Overview | null
}

/**
 * The whole tour.json: route stops sorted by number (a re-shown number already replaced its
 * earlier showing in `stops`), asides in arrival order. `v` must increase on every write.
 * `overview` is left out, not null, when the project has none.
 */
export function tourDoc(head: DocHead, route: Route, stops: readonly Stop[]): TourDoc {
  const routeStops = stops.filter(s => !s.ask).sort((a, b) => a.n - b.n)
  const asides = stops.filter(s => s.ask)
  const { overview, ...rest } = head
  return {
    ...rest,
    ...(overview ? { overview } : {}),
    question: route.question,
    plan: planOf(route),
    stops: routeStops.map(stopDoc),
    asides: asides.map(s => ({ ...stopDoc(s), ask: s.ask, from: s.from })),
  }
}

/**
 * When an archive file's tour was started, read off its name (`...-t-<ms>.json`), so the list
 * can be put in order without opening every file; null for a name that carries no id.
 */
export function archiveMs(name: string): number | null {
  const m = /-t-(\d+)\.json$/.exec(name)
  return m ? Number(m[1]) : null
}

/** Consecutive line numbers back into runs: the inverse of expandHighlight. */
function rangesOfLines(lines: readonly number[]): Range[] {
  const out: Range[] = []
  for (const n of [...lines].sort((a, b) => a - b)) {
    const last = out.at(-1)
    if (last && n <= last.to + 1) last.to = Math.max(last.to, n)
    else out.push({ from: n, to: n })
  }
  return out
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** One stop as the mod keeps it, from its tour.json form; asides keep their ask and from. */
function stopOf(s: Record<string, unknown>): Stop {
  const focus = Array.isArray(s.focus) ? s.focus.map(str) : []
  return {
    id: str(s.id),
    file: str(s.file),
    // fileUrl is `files/<key>.txt`; the key names the stored text the page loads.
    fileKey: str(s.fileUrl).replace(/^.*\//, '').replace(/\.txt$/, ''),
    fileLines: num(s.fileLines),
    start: num(s.start),
    end: num(s.end),
    highlight: rangesOfLines(Array.isArray(s.highlight) ? s.highlight.map(num) : []),
    title: str(s.title),
    say: str(s.say),
    note: str(s.note),
    ask: str(s.ask),
    from: num(s.from),
    n: str(s.ask) ? 0 : num(s.n),
    svg: str(s.svg),
    diagramCaption: str(s.diagramCaption),
    diagramWhy: str(s.diagramWhy),
    codeWhy: str(s.codeWhy),
    mode: str(s.mode),
    node: str(s.node),
    focus,
  }
}

/**
 * An archived tour.json read back, or null when the text is not one (not JSON, no question, no
 * stop lists): a corrupt archive is passed over, never an error.
 */
export function parseArchive(text: string): TourDoc | null {
  try {
    const d = JSON.parse(text) as TourDoc
    const isTour = d && typeof d === 'object' && typeof d.question === 'string' && Array.isArray(d.stops) && Array.isArray(d.asides)
    return isTour ? { ...d, tourId: str(d.tourId), plan: Array.isArray(d.plan) ? d.plan : [] } : null
  } catch {
    return null
  }
}

/** The route and stops an archived tour held, ready to put back in the mod's state: the inverse of tourDoc. */
export function restoreOf(doc: TourDoc): { route: Route; stops: Stop[] } {
  const items = [...doc.stops, ...doc.asides] as unknown as Record<string, unknown>[]
  return {
    route: { question: doc.question, stops: doc.plan.map(p => str(p?.title)) },
    stops: items.filter(s => s && typeof s === 'object').map(stopOf),
  }
}
