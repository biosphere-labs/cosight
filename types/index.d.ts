// The cosight mod's state contract: the tour so far, and what the web page is sent.

/** What the tour looks for. */
export type Lens = 'general' | 'performance' | 'implementation' | 'bugs'

/** A run of lines, 1-based and inclusive. */
export type Range = { from: number; to: number }

/**
 * Where Claude is, as the page reports it while there is nothing else to show:
 * `idle` (on, nothing asked), `reading` (reading code before the plan), `writing` (plan set,
 * stops still arriving), `answering` (a page question is with Claude), `done` (its turn ended),
 * `off`.
 */
export type Phase = 'idle' | 'reading' | 'writing' | 'answering' | 'done' | 'off'

/**
 * The project's overview diagram: a Mermaid flowchart of the whole project (its modules and
 * components, the picture a README shows), drawn once by Claude when it plans a tour and kept
 * on disk per project directory for every later tour of it. Each stop names the box it lives
 * in, so the page can zoom the overview to it.
 */
export type Overview = {
  /** Mermaid source. */
  src: string
  /** A short caption over it; '' when none. */
  caption: string
  /** When it was drawn, in `$.clock.now()`'s milliseconds. */
  written: number
}

/** One stop on the tour: a range of a file, the lines under discussion, and what was said. */
export type Stop = {
  /** The tool call's id. */
  id: string
  /** The file as shown, relative to the session's directory when beneath it. */
  file: string
  /** The name the whole file's text was written under, `files/<fileKey>.txt`. */
  fileKey: string
  /** How many lines the whole file has. */
  fileLines: number
  /** The first and last line the stop is about. */
  start: number
  end: number
  /** The lines being talked about; drawn brighter than the rest of the range. */
  highlight: Range[]
  /** A short heading for the stop. */
  title: string
  /** What is spoken for this stop. */
  say: string
  /** Detail to read, drawn under the code; '' when none. */
  note: string
  /**
   * The person's question when this stop answers one mid-tour; '' for a stop on the
   * route. An answer is an aside: it is not numbered, and the page lists it under the
   * stop it was asked at, with a way back.
   */
  ask: string
  /** For an aside, the number of the route stop it was asked at; 0 for a route stop. */
  from: number
  /** For a route stop, its number in the planned route (1-based); 0 for an aside. */
  n: number
  /** Mermaid source or inline SVG for the web page's diagram pane; '' when this stop gave none. */
  svg: string
  /** Caption over the diagram pane; '' when none. */
  diagramCaption: string
  /** One short phrase under the diagram caption saying what to do with it; '' when none. */
  diagramWhy: string
  /** Same, for the code pane; '' when none. */
  codeWhy: string
  /** Pane layout the stop suggests: 'split', 'map' (diagram leads) or 'code'; '' for the default. */
  mode: string
  /** The id of the box in the project overview diagram this stop lives in; '' when it named none. */
  node: string
  /**
   * One entry per sentence of `say`, in order: the id of the box in this stop's own diagram
   * (`svg`) that sentence talks about, or '' for none, so the page can pan to the box the voice
   * is on. [] when the stop gave none, or gave no diagram of its own to point into.
   */
  focus: string[]
}

/** The planned tour: the question it answers and its stops' titles, in order. */
export type Route = { question: string; stops: string[] }

/** One stop as tour.json carries it. */
export type StopDoc = {
  /** The overview box the stop lives in (a Mermaid node id); absent when the stop named none. */
  node?: string
  /**
   * Speech-following focus: one entry per sentence of `say`, in order, each the id of a box in
   * this stop's own `svg` diagram that sentence talks about, or '' for none. Absent when the stop
   * gave none, all were '', or the stop has no diagram of its own.
   */
  focus?: string[]
  id: string
  n: number
  title: string
  say: string
  note: string
  file: string
  fileUrl: string
  fileLines: number
  lang: string
  start: number
  end: number
  highlight: number[]
  svg: string
  diagramCaption: string
  diagramWhy: string
  codeWhy: string
  mode: string
}

/** tour.json, the one document the page renders from (the server adds `audio` per stop). */
export type TourDoc = {
  v: number
  tourId: string
  lens: string
  phase: Phase
  status: string
  mute: { v: number; on: boolean }
  /** The terminal's last /tour speed; the page applies it when `v` changes. */
  speed: { v: number; rate: number }
  /** The session's working directory, absolute, when the document was written. */
  project: string
  /** `fileKey(project)`: the name the project's overview is cached under. */
  projectKey: string
  /** The project's overview diagram; absent when none has been drawn yet. */
  overview?: Overview
  question: string
  plan: { n: number; title: string }[]
  stops: StopDoc[]
  asides: (StopDoc & { ask: string; from: number })[]
}

/**
 * One press on the web page, as tour-server.js files it in requests.jsonl: a typed question
 * (from the box or a diagram box), or Hold.
 */
export type PageRequest = {
  project?: string
  /** `question` or `hold` (`advance` from an older page is read and ignored). */
  kind: string
  /** The question's words; '' for the others. */
  text: string
  /** The route stop the page was on; 0 when it was on none. */
  step: number
  /** That stop's heading, as the page showed it. */
  heading: string
}

/** A question asked on the page and handed to Claude; `isAnswered` once an aside carried it. */
export type PageAsk = { text: string; isAnswered: boolean }

declare module 'claude-code' {
  interface PluginState {
    'cosight': {
      isOn: boolean
      /** The terminal's last /tour quiet|voice, pushed to the page as `mute`; the page's own button wins after that. */
      isQuiet: boolean
      /** How many times /tour quiet|voice was given, so the page can tell a new push from the old one. */
      muteVersion: number
      /** The terminal's last /tour speed <rate>, pushed to the page as `speed`; 1 until set. */
      speed: number
      /** How many times /tour speed was given. */
      speedVersion: number
      lens: Lens
      stops: Stop[]
      /** True once the tour's tools are registered this session. */
      hasTool: boolean
      /** The planned route; empty until Claude plans the tour. */
      route: Route
      /** True once this session has tried to bring the browser canvas up. */
      canvasReady: boolean
      /** The canvas's resolved URL, set once canvasReady is true. */
      canvasUrl: string
      /** tour.json's `v`: must increase on every write, so the page re-renders. */
      canvasVersion: number
      /** How many lines of the page's requests.jsonl have been handed to Claude or passed over. */
      requestsSeen: number
      /** Where Claude is, for the page's progress card. */
      phase: Phase
      /** One line under the phase: the file being read, the stop being written. */
      status: string
      /** Changes on every plan, so the page keeps its place per tour. */
      tourId: string
      /**
       * The current project's overview diagram, read from overviews/<projectKey>.json when the
       * tour is switched on and set by a plan that draws one; null when the project has none.
       */
      overview: Overview | null
      /**
       * Questions asked on the page and handed to Claude this tour switch-on, each marked once an
       * aside answers it. Only these may become asides: the terminal's own conversation is
       * answered in the terminal, never on the page.
       */
      pageAsks: PageAsk[]
    }
  }
}
