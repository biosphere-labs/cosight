// The project overview: the cache key, which box an entry sits in, and the moves between stops.
import { describe, expect, test } from 'vitest'

// A plain script, as the page loads it: it puts its functions on globalThis.
import '../assets/overview.js'
import type { OverviewApi, OverviewDoc, OverviewEntry } from '../assets/overview'
import { fileKey } from '../hooks/canvas'

const ov = (globalThis as unknown as { CoSightOverview: OverviewApi }).CoSightOverview

const stop = (n: number, over: Partial<OverviewEntry> = {}): OverviewEntry => ({
  id: `tu${n}`, n, title: `Stop ${n}`, say: '', note: '', file: 'src/a.ts', fileUrl: 'files/a.txt', fileLines: 12,
  lang: 'ts', start: 1, end: 12, highlight: [], svg: '', diagramCaption: '', diagramWhy: '', codeWhy: '', mode: '',
  ...over,
})
const answer = (id: string, from: number, over: Partial<OverviewEntry> = {}): OverviewEntry => ({ ...stop(0, { id }), ask: `Why ${id}?`, from, ...over })
const tour = (stops: OverviewEntry[], asides: OverviewEntry[] = []): OverviewDoc => ({ overview: { src: 'flowchart LR\n  api --> db', caption: '', written: 1 }, stops, asides })

describe('keyOf', () => {
  test('is FNV-1a over the source, hex padded to 8, then the length: the same name fileKey gives', () => {
    expect(ov.keyOf('')).toBe('811c9dc5-0')
    expect(ov.keyOf('flowchart LR\n  A --> B')).toBe('dabf6fd8-22')
    for (const s of ['', 'a', 'flowchart LR\n  A --> B', 'héllo ✓ 日本', 'x'.repeat(5000)]) expect(ov.keyOf(s)).toBe(fileKey(s))
  })

  test('matches what the tour server accepts as a key', () => {
    expect(ov.keyOf('flowchart TD\n  a --> b')).toMatch(/^[a-f0-9]{8}-\d{1,9}$/)
  })
})

describe('nodeOf', () => {
  const d = tour([stop(1, { node: 'api' }), stop(2)], [answer('p', 1), answer('q', 2), answer('r', 1, { node: 'db' }), answer('none', 0)])

  test('is the entry\'s own box, else the box of the stop an answer was asked at, else null', () => {
    expect(ov.nodeOf(d, d.stops[0]!)).toBe('api')
    expect(ov.nodeOf(d, d.stops[1]!)).toBeNull()
    expect(ov.nodeOf(d, d.asides![0]!)).toBe('api')
    expect(ov.nodeOf(d, d.asides![1]!)).toBeNull()
    expect(ov.nodeOf(d, d.asides![2]!)).toBe('db')
    expect(ov.nodeOf(d, d.asides![3]!)).toBeNull()
    expect(ov.nodeOf(d, null)).toBeNull()
  })
})

describe('steps', () => {
  const enter = (n: string) => [{ t: 'pan', node: n }, { t: 'in', node: n }, { t: 'mark', node: n }]

  test('between two boxes with motion on: fade the old box, zoom out, travel, zoom in, highlight, hold, then the own diagram', () => {
    expect(ov.steps('api', 'db', { motion: true, own: true })).toEqual([
      { t: 'leave', node: 'api' }, { t: 'out' }, ...enter('db'), { t: 'hold' }, { t: 'own' },
    ])
    // Without a diagram of its own there is nothing to hold for: the box stays on screen.
    expect(ov.steps('api', 'db', { motion: true, own: false })).toEqual([{ t: 'leave', node: 'api' }, { t: 'out' }, ...enter('db')])
  })

  test('the tour\'s first show starts on the whole overview; no earlier box means out, then in, nothing to fade', () => {
    expect(ov.steps(null, 'db', { motion: true, own: true, first: true })).toEqual([{ t: 'fit' }, ...enter('db'), { t: 'hold' }, { t: 'own' }])
    expect(ov.steps(null, 'db', { motion: true, own: false })).toEqual([{ t: 'out' }, ...enter('db')])
  })

  test('the same box stays put, and holds before the own diagram', () => {
    expect(ov.steps('api', 'api', { motion: true, own: true })).toEqual([{ t: 'stay', node: 'api' }, { t: 'hold' }, { t: 'own' }])
    expect(ov.steps('api', 'api', { motion: true })).toEqual([{ t: 'stay', node: 'api' }])
  })

  test('motion off cuts straight to the box, holds it, then the own diagram', () => {
    expect(ov.steps('api', 'db', { motion: false, own: true })).toEqual([{ t: 'jump', node: 'db' }, { t: 'hold' }, { t: 'own' }])
    expect(ov.steps(null, 'db', { motion: false, first: true })).toEqual([{ t: 'jump', node: 'db' }])
  })

  test('an entry with no box: with motion, leave the old box and zoom out; else fit at once', () => {
    expect(ov.steps('api', null, { motion: true, own: true })).toEqual([{ t: 'leave', node: 'api' }, { t: 'out' }, { t: 'own' }])
    expect(ov.steps('api', null, { motion: false })).toEqual([{ t: 'fit' }])
    expect(ov.steps(null, null, { motion: true })).toEqual([{ t: 'fit' }])
    expect(ov.steps(null, null)).toEqual([{ t: 'fit' }])
  })
})

describe('sentencesOf', () => {
  test('ends a sentence at . ! or ? before a space, keeping closing quotes, with where each starts', () => {
    expect(ov.sentencesOf('Run reads the job. Then it plans!  Why? "Because." Done')).toEqual([
      { text: 'Run reads the job.', start: 0 },
      { text: 'Then it plans!', start: 19 },
      { text: 'Why?', start: 35 },
      { text: '"Because."', start: 40 },
      { text: 'Done', start: 51 },
    ])
  })

  test('does not end one inside a word, a number, or after e.g. and i.e.', () => {
    expect(ov.sentencesOf('It reads config.ts, about 1.5 KB, e.g. the ports, i.e. what to bind. Then it binds.').map(x => x.text))
      .toEqual(['It reads config.ts, about 1.5 KB, e.g. the ports, i.e. what to bind.', 'Then it binds.'])
  })

  test('a blank line ends one too; empty text has none', () => {
    expect(ov.sentencesOf('A heading\n\nThe body.').map(x => x.text)).toEqual(['A heading', 'The body.'])
    expect(ov.sentencesOf('')).toEqual([])
    expect(ov.sentencesOf('   ')).toEqual([])
  })
})

describe('cuesOf and cueAt', () => {
  const say = 'Aaaa aaaa. Bbbb bbbb bbbb bbbb. Cccc cccc.'

  test('each sentence starts at its share of the characters before it, times the length of the speech', () => {
    // 10 + 20 + 10 characters over 8 seconds: starts at 0, 2 and 6.
    const cs = ov.cuesOf(say, ['api', '', 'db'], 8)
    expect(cs.map(c => c.at)).toEqual([0, 2, 6])
    expect(cs.map(c => c.node)).toEqual(['api', '', 'db'])
    expect(cs.map(c => c.char)).toEqual([0, 11, 32])
  })

  test('a missing or non-string focus entry is no box, and an unknown length puts every start at 0', () => {
    expect(ov.cuesOf(say, ['api'], 8).map(c => c.node)).toEqual(['api', '', ''])
    expect(ov.cuesOf(say, undefined, NaN).map(c => c.at)).toEqual([0, 0, 0])
  })

  test('cueAt is the sentence the voice is on, by time or by character', () => {
    const cs = ov.cuesOf(say, ['api', '', 'db'], 8)
    expect(ov.cueAt(cs, -1)).toBe(-1)
    expect(ov.cueAt(cs, 0)).toBe(0)
    expect(ov.cueAt(cs, 1.99)).toBe(0)
    expect(ov.cueAt(cs, 2)).toBe(1)
    expect(ov.cueAt(cs, 7.5)).toBe(2)
    expect(ov.cueAt(cs, 0, 12)).toBe(1)
    expect(ov.cueAt(cs, 0, 40)).toBe(2)
    expect(ov.cueAt([], 3)).toBe(-1)
  })
})

describe('motionOn', () => {
  test('on and off are what they say; anything else follows the browser', () => {
    expect(ov.motionOn('on', true)).toBe(true)
    expect(ov.motionOn('off', false)).toBe(false)
    expect(ov.motionOn('auto', false)).toBe(true)
    expect(ov.motionOn('auto', true)).toBe(false)
    expect(ov.motionOn('', true)).toBe(false)
  })
})

describe('nodeMatch', () => {
  test('ranks data-id over Mermaid\'s element id over the label, and nothing else', () => {
    expect(ov.nodeMatch({ dataId: 'api', id: 'flowchart-api-12', label: 'API' }, 'api')).toBe(3)
    expect(ov.nodeMatch({ dataId: null, id: 'flowchart-api-12', label: 'The API' }, 'api')).toBe(2)
    expect(ov.nodeMatch({ id: 'classId-Order-3' }, 'Order')).toBe(2)
    expect(ov.nodeMatch({ id: 'state-Idle-7' }, 'Idle')).toBe(2)
    // Mermaid 12.1 puts the render id in front, and names a cluster <render id>-<subgraph id>.
    expect(ov.nodeMatch({ id: 'mmdmve7v0n82-flowchart-db-3', label: 'Database' }, 'db')).toBe(2)
    expect(ov.nodeMatch({ id: 'mermaid-17-flowchart-w1-7', label: 'Worker' }, 'w1')).toBe(2)
    expect(ov.nodeMatch({ id: 'mmdmve7v0n82-workers', label: 'Workers' }, 'workers')).toBe(2)
    expect(ov.nodeMatch({ id: 'workers' }, 'workers')).toBe(2)
    expect(ov.nodeMatch({ id: 'mmdmve7v0n82-flowchart-cli-0' }, '0')).toBe(0)
    expect(ov.nodeMatch({ id: 'flowchart-api2-12' }, 'api')).toBe(0)
    expect(ov.nodeMatch({ id: 'flowchart-api-12' }, 'ap')).toBe(0)
    expect(ov.nodeMatch({ id: 'x', label: '  Api \n' }, 'API')).toBe(1)
    expect(ov.nodeMatch({ dataId: 'db', id: 'flowchart-db-1', label: 'db' }, 'api')).toBe(0)
    expect(ov.nodeMatch({ dataId: 'db' }, '')).toBe(0)
  })

  test('takes an id with regex characters literally', () => {
    expect(ov.nodeMatch({ id: 'flowchart-a.b-4' }, 'a.b')).toBe(2)
    expect(ov.nodeMatch({ id: 'flowchart-aXb-4' }, 'a.b')).toBe(0)
  })
})

describe('zoomFor', () => {
  test('fills the pane with the box times three, centred on the box', () => {
    const z = ov.zoomFor({ x: 100, y: 50, w: 80, h: 40 }, { w: 600, h: 400 }, 0.5)
    expect(z.k).toBe(2.5)
    // The box's centre (140, 70) lands at the pane's centre (300, 200).
    expect(140 * z.k + z.x).toBe(300)
    expect(70 * z.k + z.y).toBe(200)
  })

  test('never zooms in past 3, and never closer to fit than fit times 1.3', () => {
    expect(ov.zoomFor({ x: 0, y: 0, w: 10, h: 10 }, { w: 600, h: 400 }, 0.5).k).toBe(3)
    expect(Math.round(ov.zoomFor({ x: 0, y: 0, w: 500, h: 300 }, { w: 600, h: 400 }, 0.5).k * 1000)).toBe(650)
    expect(ov.zoomFor({ x: 0, y: 0, w: 0, h: 0 }, { w: 600, h: 400 }, 0.5).k).toBe(3)
  })
})
