// The types of overview.js, for tests/overview.test.ts. The page loads overview.js as a plain script.

import type { Overview, StopDoc } from '../types'

/**
 * A route stop or an answer, as tour.json carries them; `node` names its box in the overview, and
 * `focus` names, per sentence of `say`, the box of its own diagram that sentence is about.
 */
export type OverviewEntry = StopDoc & { ask?: string; from?: number; focus?: string[] }

/** The parts of tour.json the overview logic reads. */
export type OverviewDoc = { overview?: Overview; stops: OverviewEntry[]; asides?: OverviewEntry[] }

/** One move of the diagram pane between two entries, in the order steps() gives them. */
export type MoveStep =
  | { t: 'fit' | 'out' | 'hold' | 'own' }
  | { t: 'leave' | 'pan' | 'in' | 'mark' | 'jump' | 'stay'; node: string }

/** One sentence of the spoken text, and where it starts in that text. */
export type Sentence = { text: string; start: number }

/** One sentence in the voice: when it starts (seconds), where (character), and the box it is about ('' for none). */
export type Cue = { at: number; char: number; node: string }

/** The person's "Zoom between stops" choice: follow the browser, on, or off. */
export type MotionSetting = 'auto' | 'on' | 'off'

/** A node's box in the diagram's own, untransformed pixels. */
export type Box = { x: number; y: number; w: number; h: number }

/** What the page reads off one SVG element to match it to a node id. */
export type NodeCandidate = { dataId?: string | null; id?: string | null; label?: string | null }

/** What overview.js puts on globalThis as CoSightOverview. */
export type OverviewApi = {
  keyOf(src: string): string
  nodeOf(doc: OverviewDoc, entry: OverviewEntry | null): string | null
  steps(prev: string | null, next: string | null, opts?: { motion?: boolean; own?: boolean; first?: boolean }): MoveStep[]
  sentencesOf(text: string): Sentence[]
  cuesOf(say: string, focus: readonly string[] | undefined, duration: number): Cue[]
  cueAt(cues: readonly Cue[], t: number, char?: number | null): number
  motionOn(setting: MotionSetting | string, reducedMotion: boolean): boolean
  nodeMatch(cand: NodeCandidate, id: string): 0 | 1 | 2 | 3
  zoomFor(box: Box, pane: { w: number; h: number }, fitK: number): { k: number; x: number; y: number }
}
