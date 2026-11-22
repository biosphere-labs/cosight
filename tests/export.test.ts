// Edit mode's export: the list the person arranges, and the Markdown made from it.
import { describe, expect, test } from 'vitest'

// A plain script, as the page loads it: it puts its functions on globalThis.
import '../assets/export.js'
import type { Entry, ExportApi, ExportDoc } from '../assets/export'

const exp = (globalThis as unknown as { CoSightExport: ExportApi }).CoSightExport

const stop = (n: number, over: Partial<Entry> = {}): Entry => ({
  id: `tu${n}`, n, title: `Stop ${n}`, say: `Said at ${n}.`, note: '', file: 'src/a.ts', fileUrl: 'files/a.txt', fileLines: 12,
  lang: 'ts', start: 1, end: 12, highlight: [], svg: '', diagramCaption: '', diagramWhy: '', codeWhy: '', mode: '',
  ...over,
})
const answer = (id: string, from: number, over: Partial<Entry> = {}): Entry => ({ ...stop(0, { id, title: `Answer ${id}` }), ask: `Why ${id}?`, from, ...over })
const tour = (stops: Entry[], asides: Entry[] = []): ExportDoc => ({ question: 'How does a run flow?', lens: 'general', stops, asides })

describe('the export list', () => {
  test('starts as the tour, every section ticked: each stop, then the answers asked at it; answers from before any stop last', () => {
    const d = tour([stop(2), stop(1)], [answer('p', 1), answer('early', 0), answer('q', 2)])
    expect(exp.defaultOrder(d)).toEqual(['s:1', 'a:p', 's:2', 'a:q', 'a:early'])
    expect(exp.arrange(d, null)).toEqual({ order: ['s:1', 'a:p', 's:2', 'a:q', 'a:early'], off: [] })
  })

  test('keeps the order and the unticked sections in place, and drops what is gone', () => {
    const d = tour([stop(1), stop(2), stop(3)], [answer('p', 1)])
    const ar = exp.arrange(d, { order: ['s:3', 'a:gone', 's:2', 's:1', 'a:p'], off: ['s:2', 's:9'] })
    expect(ar).toEqual({ order: ['s:3', 's:2', 's:1', 'a:p'], off: ['s:2'] })
    expect(exp.ticked(ar)).toEqual(['s:3', 's:1', 'a:p'])
  })

  test('only ticked sections go into the export; untick all leaves nothing, and new sections arrive ticked', () => {
    const d = tour([stop(1), stop(2)], [answer('p', 1)])
    const all = exp.arrange(d, null).order
    const none = exp.arrange(d, { order: all, off: all })
    expect(exp.ticked(none)).toEqual([])
    const later = tour([stop(1), stop(2), stop(3)], [answer('p', 1), answer('q', 2)])
    const ar = exp.arrange(later, { order: all, off: all })
    expect(ar.order).toEqual(['s:1', 'a:p', 's:2', 'a:q', 's:3'])
    expect(exp.ticked(ar)).toEqual(['a:q', 's:3'])
  })

  test('a list saved before the tick boxes: what was left out comes back unticked, where it belongs', () => {
    const d = tour([stop(1), stop(2), stop(3)], [answer('q', 2)])
    const ar = exp.arrange(d, { order: ['s:3', 's:1'], removed: ['s:2'] })
    expect(ar).toEqual({ order: ['s:3', 's:1', 's:2', 'a:q'], off: ['s:2'] })
    expect(exp.ticked(ar)).toEqual(['s:3', 's:1', 'a:q'])
    // Once the page has saved `off`, an old `removed` beside it no longer counts.
    expect(exp.arrange(d, { order: ['s:1', 's:2', 'a:q', 's:3'], off: [], removed: ['s:2'] }).off).toEqual([])
  })

  test('a new answer lands under the stop it was asked at, after the answers already there, wherever that stop was moved', () => {
    const d = tour([stop(1), stop(2)], [answer('p', 1), answer('q', 1)])
    expect(exp.arrange(d, { order: ['s:2', 's:1', 'a:p'] }).order).toEqual(['s:2', 's:1', 'a:p', 'a:q'])
    expect(exp.arrange(d, { order: ['s:1', 'a:p', 's:2'] }).order).toEqual(['s:1', 'a:p', 'a:q', 's:2'])
    // Under its stop even when that stop is unticked; the answer itself arrives ticked.
    expect(exp.arrange(d, { order: ['s:2', 's:1', 'a:p'], off: ['s:1'] })).toEqual({ order: ['s:2', 's:1', 'a:p', 'a:q'], off: ['s:1'] })
  })

  test('a new stop lands after the stop before it and that stop\'s answers', () => {
    expect(exp.arrange(tour([stop(1), stop(2)], [answer('p', 1)]), { order: ['s:1', 'a:p'] }).order).toEqual(['s:1', 'a:p', 's:2'])
    expect(exp.arrange(tour([stop(1), stop(2), stop(3)]), { order: ['s:3', 's:1'] }).order).toEqual(['s:3', 's:1', 's:2'])
    // Stop 2 arriving after stop 3 (Claude re-showed it, or wrote it late) goes between them, not last.
    expect(exp.arrange(tour([stop(1), stop(2), stop(3)], [answer('p', 1)]), { order: ['s:1', 'a:p', 's:3'] }).order).toEqual(['s:1', 'a:p', 's:2', 's:3'])
  })

  test('an answer to a stop not in the list yet goes under the nearest stop before it', () => {
    const d = tour([stop(1), stop(3)], [answer('q', 2)])
    expect(exp.arrange(d, { order: ['s:1', 's:3'] })).toEqual({ order: ['s:1', 'a:q', 's:3'], off: [] })
  })

  test('moveKey moves in front of another key, or to the end, and onto itself changes nothing', () => {
    expect(exp.moveKey(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(exp.moveKey(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a'])
    expect(exp.moveKey(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c'])
  })

  test('an answer is nested only straight after its own stop or a sibling answer', () => {
    const d = tour([stop(1), stop(2)], [answer('p', 1), answer('q', 1)])
    const ent = exp.entriesOf(d)
    expect(exp.nested(['s:1', 'a:p', 'a:q'], 1, ent)).toBe(true)
    expect(exp.nested(['s:1', 'a:p', 'a:q'], 2, ent)).toBe(true)
    expect(exp.nested(['s:2', 'a:p'], 1, ent)).toBe(false)
    expect(exp.nested(['a:p', 's:1'], 0, ent)).toBe(false)
  })
})

describe('the quoted code', () => {
  test('is the highlighted lines as runs, close runs joined, the whole range only when nothing is highlighted', () => {
    expect(exp.runsOf([5, 3, 4, 9, 10], 1, 40)).toEqual([{ from: 3, to: 10 }])
    expect(exp.runsOf([3, 4, 20], 1, 40)).toEqual([{ from: 3, to: 4 }, { from: 20, to: 20 }])
    expect(exp.runsOf([], 7, 12)).toEqual([{ from: 7, to: 12 }])
  })

  test('starts at the margin and is fenced so its own backticks cannot close it', () => {
    expect(exp.dedent(['    a()', '', '      b()'])).toEqual(['a()', '', '  b()'])
    expect(exp.fence('no ticks')).toBe('```')
    expect(exp.fence('x = ```')).toBe('````')
  })
})

describe('markdownOf', () => {
  const file = Array.from({ length: 12 }, (_, i) => `  line${i + 1}()`).join('\n') + '\n'
  const d = tour(
    [
      stop(1, { title: 'The entry', note: 'Read `run` first.', highlight: [3, 4], codeWhy: 'where it starts', svg: 'flowchart LR\n  A["run"] --> B["plan"]', diagramCaption: 'The flow' }),
      stop(2, { title: 'The plan', highlight: [10], fileUrl: 'files/missing.txt' }),
    ],
    [answer('p', 1, { title: 'Why run first', say: 'Because it reads the job.', svg: '<svg viewBox="0 0 1 1">\n\n<g/></svg>', highlight: [1] })],
  )
  const md = exp.markdownOf(d, ['s:1', 'a:p', 's:2'], { 'files/a.txt': file }, { title: 'Run flow', date: 'Oct 14, 2026' })

  test('carries the title, the question, every heading, and an answer nested under its stop', () => {
    expect(md.text.startsWith('# Run flow\n\n> How does a run flow?\n\n*A code tour, Oct 14, 2026.*\n')).toBe(true)
    expect(md.text).toContain('\n## The entry\n')
    expect(md.text).toContain('\n### Why run first\n\n> **Question:** Why p?\n\nBecause it reads the job.\n')
    expect(md.text).toContain('\n## The plan\n')
    expect(md.sections).toBe(3)
  })

  test('carries the writing and the diagrams: Mermaid fenced, raw SVG as one HTML block', () => {
    expect(md.text).toContain('Said at 1.\n\nRead `run` first.\n')
    expect(md.text).toContain('*The flow*\n\n```mermaid\nflowchart LR\n  A["run"] --> B["plan"]\n```\n')
    expect(md.text).toContain('<svg viewBox="0 0 1 1">\n<g/></svg>')
    expect(md.diagrams).toBe(2)
  })

  test('quotes only the highlighted lines, at the margin, and says when a file could not be loaded', () => {
    expect(md.text).toContain('`src/a.ts`, lines 3–4: where it starts\n\n```ts\nline3()\nline4()\n```\n')
    expect(md.text).not.toContain('line5()')
    expect(md.text).toContain('`src/a.ts`, line 1\n\n```ts\nline1()\n```\n')
    expect(md.text).toContain('`src/a.ts`, lines 1–12 (the file could not be loaded for this export)')
    expect(md.excerpts).toBe(2)
    expect(md.missing).toBe(1)
  })

  test('names the file by date and title, and dates the export as MMM D, YYYY', () => {
    const day = new Date(2026, 9, 4)
    expect(exp.fileNameOf('How does a run flow?', day)).toBe('2026-10-04-how-does-a-run-flow.md')
    expect(exp.fileNameOf('', day)).toBe('2026-10-04-cosight.md')
    expect(exp.dateText(day)).toBe('Oct 4, 2026')
  })
})
