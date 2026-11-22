// The types of export.js, for tests/export.test.ts. The page loads export.js as a plain script.

import type { StopDoc } from '../types'

/** A route stop or an answer, as tour.json carries them. */
export type Entry = StopDoc & { ask?: string; from?: number }

/** The parts of tour.json the export reads. */
export type ExportDoc = { question?: string; lens?: string; stops: Entry[]; asides: Entry[] }

/**
 * What the page keeps per tour: the person's order (every section, ticked or not) and the
 * unticked sections. `removed` is the shape from before the tick boxes, when a left-out section
 * was taken out of `order`; arrange reads it as unticked.
 */
export type Saved = { order?: string[]; off?: string[]; removed?: string[]; title?: string } | null

/** The export list: every key in order, and the unticked ones. */
export type Arranged = { order: string[]; off: string[] }

export type Exported = { text: string; sections: number; diagrams: number; excerpts: number; missing: number }

/** What export.js puts on globalThis as CoSightExport. */
export type ExportApi = {
  isMermaid(src: string): boolean
  keyOf(e: Entry): string
  refOf(k: string): { type: 'stop'; n: number } | { type: 'aside'; id: string }
  entriesOf(doc: ExportDoc): Record<string, Entry>
  defaultOrder(doc: ExportDoc): string[]
  arrange(doc: ExportDoc, saved: Saved): Arranged
  ticked(ar: Arranged): string[]
  moveKey(order: readonly string[], key: string, before: string | null): string[]
  nested(order: readonly string[], i: number, ent: Record<string, Entry>): boolean
  runsOf(lines: readonly number[], start: number, end: number, gap?: number): { from: number; to: number }[]
  fence(text: string): string
  dedent(lines: readonly string[]): string[]
  dateText(d: Date): string
  fileNameOf(title: string, d: Date): string
  markdownOf(doc: ExportDoc, keys: readonly string[], files: Record<string, string>, opts?: { title?: string; date?: string }): Exported
}
