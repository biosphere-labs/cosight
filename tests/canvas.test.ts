// The pure half of the browser canvas: the tour.json the page renders from.
import { describe, expect, test } from 'vitest'

import { archiveMs, archivePath, canvasUrl, expandHighlight, fileKey, overviewPath, parseArchive, parseOverview, restoreOf, tourDoc } from '../hooks/canvas'
import type { Stop } from '../types'

const stop = (over: Partial<Stop> = {}): Stop => ({
  id: 'tu1', file: 'src/a.py', fileKey: 'abc-10', fileLines: 40, start: 2, end: 4, highlight: [{ from: 3, to: 3 }],
  title: 'The middle', say: 'Here.', note: '', ask: '', from: 0, n: 1, svg: '', diagramCaption: '', diagramWhy: '', codeWhy: '', mode: '', node: '', focus: [],
  ...over,
})
const head = {
  v: 3, tourId: 't-1', lens: 'general', phase: 'writing' as const, status: 'Writing stop 2 of 2', mute: { v: 0, on: false }, speed: { v: 0, rate: 1 },
  project: '/work', projectKey: fileKey('/work'), overview: null,
}
const overview = { src: 'flowchart LR\n  api["API"] --> db["DB"]', caption: 'The project', written: 1760000000000 }

describe('tourDoc', () => {
  test('carries the head, the plan, the route stops by number and the asides under their stop', () => {
    const doc = tourDoc(head, { question: 'How?', stops: ['One', 'Two'] }, [
      stop({ id: 'b', n: 2, title: 'Two', start: 10, end: 12 }),
      stop({ id: 'q', n: 0, ask: 'Why?', from: 1, title: 'Because' }),
      stop({ id: 'a', n: 1 }),
    ])
    expect(doc.v).toBe(3)
    expect(doc.phase).toBe('writing')
    expect(doc.plan).toEqual([{ n: 1, title: 'One' }, { n: 2, title: 'Two' }])
    expect(doc.stops.map(s => s.n)).toEqual([1, 2])
    expect(doc.stops[0]).toMatchObject({ fileUrl: 'files/abc-10.txt', fileLines: 40, lang: 'py', start: 2, end: 4, highlight: [3] })
    expect(doc.asides).toHaveLength(1)
    expect(doc.asides[0]).toMatchObject({ ask: 'Why?', from: 1, n: 0, title: 'Because' })
    // Nothing about the stop's own text rides along: the page fetches the whole file by URL.
    expect('source' in doc.stops[0]!).toBe(false)
  })

  test('names the project and its key; the overview rides along only when there is one', () => {
    const none = tourDoc(head, { question: 'How?', stops: ['One'] }, [])
    expect(none.project).toBe('/work')
    expect(none.projectKey).toBe(fileKey('/work'))
    expect('overview' in none).toBe(false)
    const some = tourDoc({ ...head, overview }, { question: 'How?', stops: ['One'] }, [])
    expect(some.overview).toEqual(overview)
  })

  test('a stop carries the overview box it lives in, and no node key when it named none', () => {
    const doc = tourDoc({ ...head, overview }, { question: 'How?', stops: ['One', 'Two'] }, [
      stop({ id: 'a', n: 1, node: 'api' }),
      stop({ id: 'b', n: 2 }),
      stop({ id: 'q', n: 0, ask: 'Why?', from: 1, node: 'db' }),
    ])
    expect(doc.stops[0]!.node).toBe('api')
    expect('node' in doc.stops[1]!).toBe(false)
    expect(doc.asides[0]!.node).toBe('db')
  })
})

describe('overviewPath and parseOverview', () => {
  test('the cache file sits under overviews/ by project key', () => {
    expect(overviewPath('/home/me/.local/share/cosight', 'abcd1234-5')).toBe('/home/me/.local/share/cosight/overviews/abcd1234-5.json')
  })

  test('a good cache file is read back; a bad one counts as none', () => {
    expect(parseOverview(JSON.stringify({ project: '/work', ...overview }))).toEqual(overview)
    expect(parseOverview(JSON.stringify({ project: '/work', src: ' flowchart TD ', written: '7' }))).toEqual({ src: 'flowchart TD', caption: '', written: 7 })
    expect(parseOverview(JSON.stringify({ src: '', written: 1 }))).toBeNull()
    expect(parseOverview(JSON.stringify({ src: 'flowchart TD' }))).toBeNull()
    expect(parseOverview('one\ntwo')).toBeNull()
    expect(parseOverview('null')).toBeNull()
  })
})

describe('fileKey, expandHighlight, canvasUrl', () => {
  test('the same text gets the same key, a changed text a new one', () => {
    expect(fileKey('abc')).toBe(fileKey('abc'))
    expect(fileKey('abc')).not.toBe(fileKey('abd'))
    expect(fileKey('abc')).toMatch(/^[0-9a-f]{8}-3$/)
  })

  test('highlight ranges become sorted, deduped absolute lines', () => {
    expect(expandHighlight([{ from: 5, to: 6 }, { from: 2, to: 3 }, { from: 6, to: 6 }])).toEqual([2, 3, 5, 6])
  })

  test('the URL is loopback on the given port', () => {
    expect(canvasUrl(8099)).toBe('http://127.0.0.1:8099/')
    expect(canvasUrl(8099, '203.0.113.10')).toBe('http://203.0.113.10:8099/')
  })
})

describe('focus and the archive', () => {
  test('focus rides along only with the stop\'s own diagram and at least one box named', () => {
    const doc = tourDoc(head, { question: 'How?', stops: ['One'] }, [
      stop({ id: 'a', n: 1, svg: 'flowchart LR\n  a --> b', focus: ['a', '', 'b'] }),
      stop({ id: 'b', n: 2, svg: 'flowchart LR\n  a --> b', focus: ['', ''] }),
      stop({ id: 'c', n: 3, focus: ['a'] }),
      stop({ id: 'q', n: 0, ask: 'Why?', from: 1, svg: 'flowchart LR\n  a', focus: ['a'] }),
    ])
    expect(doc.stops[0]!.focus).toEqual(['a', '', 'b'])
    expect('focus' in doc.stops[1]!).toBe(false)
    expect('focus' in doc.stops[2]!).toBe(false)
    expect(doc.asides[0]!.focus).toEqual(['a'])
  })

  test('an archive is named by the tour\'s own date, a slug of its question and its id', () => {
    const ms = Date.UTC(2026, 9, 19, 23, 59)
    expect(archivePath('/w', 'Why does the merge gate refuse…?', `t-${ms}`, 0)).toBe(`/w/tours/2026-10-19-why-does-the-merge-gate-refuse-t-${ms}.json`)
    // No question, no id: the day it was archived, "tour", and a made-up id.
    expect(archivePath('/w', '', '', Date.UTC(2026, 0, 2))).toBe(`/w/tours/2026-01-02-tour-t-${Date.UTC(2026, 0, 2)}.json`)
  })
})

describe('kept tours read back', () => {
  test('restoreOf undoes tourDoc: route, stops, asides with their ask and from, highlight runs', () => {
    const stops = [
      stop({ id: 'a', n: 1, highlight: [{ from: 2, to: 3 }, { from: 5, to: 5 }], svg: 'flowchart LR\n a --> b', focus: ['a', ''], node: 'api' }),
      stop({ id: 'b', n: 2, title: 'Two' }),
      stop({ id: 'q', n: 0, ask: 'Why?', from: 2, title: 'Because' }),
    ]
    const route = { question: 'How?', stops: ['One', 'Two', 'Three'] }
    const doc = parseArchive(JSON.stringify(tourDoc(head, route, stops)))!
    expect(restoreOf(doc)).toEqual({ route, stops })
    // A tour.json written again from what was restored is the same page.
    expect(tourDoc(head, route, restoreOf(doc).stops)).toEqual(tourDoc(head, route, stops))
  })

  test('a corrupt archive is none; the start time comes from the file name', () => {
    expect(parseArchive('{not json')).toBeNull()
    expect(parseArchive('{"question":"Q"}')).toBeNull()
    expect(parseArchive('null')).toBeNull()
    expect(parseArchive('{"question":"Q","stops":[],"asides":[]}')).toMatchObject({ tourId: '', plan: [] })
    expect(archiveMs(archivePath('/w', 'How?', 't-1760000000000', 0).split('/').at(-1)!)).toBe(1760000000000)
    expect(archiveMs('notes.json')).toBeNull()
  })
})
