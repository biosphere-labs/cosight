// The pure half: arguments, ranges, highlight runs, speech text.
import { describe, expect, test } from 'vitest'

import { HISTORY_MAX, INPUT_SCHEMA, MAX_LINES, PLAN_SCHEMA, askFor, claimAsk, clampRange, focusOf, historyText, overviewOf, overviewText, pageRequestsText, parseTour, promptFor, rangesOf, readingStatus, requestsOf, routeOf, shortDate, spoken } from '../hooks/tour'

describe('parseTour', () => {
  test('bare /tour and "on" switch it on; off, quiet, voice do what they say', () => {
    expect(parseTour('')).toEqual({ action: 'on' })
    expect(parseTour(' on ')).toEqual({ action: 'on' })
    expect(parseTour('off')).toEqual({ action: 'off' })
    expect(parseTour('quiet')).toEqual({ action: 'quiet' })
    expect(parseTour('voice')).toEqual({ action: 'voice' })
    expect(parseTour('speed 1.2')).toEqual({ action: 'speed', rate: 1.2 })
    expect(parseTour('speed 5')).toEqual({ action: 'speed', rate: null })
    expect(parseTour('speed')).toEqual({ action: 'speed', rate: null })
  })

  test('a lens word comes first, the rest is the target', () => {
    expect(parseTour('perf src/runner.ts')).toEqual({ action: 'start', lens: 'performance', target: 'src/runner.ts' })
    expect(parseTour('bugs why does resume hang')).toEqual({ action: 'start', lens: 'bugs', target: 'why does resume hang' })
    expect(parseTour('src/a.ts')).toEqual({ action: 'start', lens: null, target: 'src/a.ts' })
  })

  test('history lists, history <n> picks; more words are a question about history', () => {
    expect(parseTour('history')).toEqual({ action: 'history', n: null })
    expect(parseTour(' History 3 ')).toEqual({ action: 'history', n: 3 })
    expect(parseTour('history x')).toEqual({ action: 'history', n: NaN })
    expect(parseTour('history of the merge gate')).toEqual({ action: 'start', lens: null, target: 'history of the merge gate' })
    expect(parseTour('bugs history')).toEqual({ action: 'start', lens: 'bugs', target: 'history' })
  })
})

describe('clampRange', () => {
  test('keeps the range inside the file', () => {
    expect(clampRange(0, 5, 3)).toEqual({ start: 1, end: 3 })
    expect(clampRange(9, 2, 20)).toEqual({ start: 9, end: 9 })
  })

  test('caps one stop at MAX_LINES', () => {
    expect(clampRange(1, 500, 1000)).toEqual({ start: 1, end: MAX_LINES })
  })
})

describe('routeOf and overviewOf', () => {
  test('keeps the question and the non-empty titles', () => {
    expect(routeOf({ question: ' How? ', stops: ['One', '', ' Two ', 3] })).toEqual({ question: 'How?', stops: ['One', 'Two', '3'] })
    expect(routeOf({})).toEqual({ question: '', stops: [] })
  })

  test('an overview is the trimmed source and caption; a blank one is none', () => {
    expect(overviewOf({ overview: ' flowchart LR\n  api --> db ', overviewCaption: ' The project ' })).toEqual({
      src: 'flowchart LR\n  api --> db',
      caption: 'The project',
    })
    expect(overviewOf({ overview: 'flowchart TD' })).toEqual({ src: 'flowchart TD', caption: '' })
    expect(overviewOf({ overview: '  ', overviewCaption: 'x' })).toBeNull()
    expect(overviewOf({})).toBeNull()
  })

  test('the schemas carry the overview fields and the stop\'s node', () => {
    expect(PLAN_SCHEMA.properties.overview.type).toBe('string')
    expect(PLAN_SCHEMA.properties.overviewCaption.type).toBe('string')
    expect(PLAN_SCHEMA.required).toEqual(['question', 'stops'])
    expect(INPUT_SCHEMA.properties.node.description).toBe(
      'The id of the box in the project overview diagram this stop lives in (its Mermaid node id, e.g. api). Every route stop should have one.',
    )
  })
})

describe('spoken and rangesOf', () => {
  test('paths shrink to their last segment, backticks and markdown go', () => {
    expect(spoken('The **loop** in `/home/developer/x/pipeline/src/runner.ts` retries.')).toBe('The loop in runner.ts retries.')
  })

  test('malformed highlight entries are dropped, reversed ones put right', () => {
    expect(rangesOf([{ from: 5, to: 3 }, { from: 'x' }, { from: 7 }, null])).toEqual([
      { from: 3, to: 5 },
      { from: 7, to: 7 },
    ])
    expect(rangesOf('nope')).toEqual([])
  })
})

describe('the words Claude reads', () => {
  test('the ask names the tool and the lens', () => {
    const a = askFor('performance')
    expect(a).toContain('mcp__cosight__show')
    expect(a).toContain('mcp__cosight__plan')
    expect(a).toContain('Focus on performance')
  })

  test('the ask asks for a diagram on every stop and says page requests come in', () => {
    const a = askFor('general')
    expect(a).toContain('Give every route stop a diagram in "svg"')
    expect(a).toContain('Mermaid')
    expect(a).toContain('from the web page')
  })

  test('without an overview, the ask asks the plan to draw one and every stop to name its box', () => {
    const a = askFor('general')
    const para = a.split('\n').find(l => l.startsWith('Also give plan an "overview"'))
    expect(para).toBe(
      'Also give plan an "overview": a Mermaid flowchart (flowchart LR or TD) of the whole project, its modules and ' +
        'components, the picture a README would show, ten to fifteen boxes, each with a short plain id such as api, ' +
        'worker, db and a quoted label. The page keeps it for every later tour of this project and zooms into it at ' +
        'each stop, so give every route stop a "node": the id of the box it lives in.',
    )
    expect(askFor('general', null)).toBe(a)
    expect(a).not.toContain('already has an overview')
    // It comes right after the per-stop diagram paragraph, before the lens.
    const lines = a.split('\n')
    expect(lines.indexOf(para!)).toBe(lines.findIndex(l => l.startsWith('Give every route stop a diagram')) + 1)
    expect(lines.indexOf(para!)).toBeLessThan(lines.findIndex(l => l.startsWith('Explain what the code does')))
  })

  test('with a cached overview, the ask shows it with its date and asks for a node per stop', () => {
    const src = 'flowchart LR\n  api["API"] --> db["Database"]'
    const a = askFor('bugs', { src, written: Date.UTC(2026, 9, 14, 15, 30) })
    expect(a).toContain(
      'The project already has an overview diagram, drawn Oct 14, 2026, which the page zooms into at each stop:\n' +
        '```mermaid\n' + src + '\n```\n' +
        'Give every route stop a "node": the id of the box in it the stop lives in. If the code has changed so this ' +
        'diagram no longer fits, draw a new one in plan\'s "overview" and name its boxes instead.',
    )
    expect(a).not.toContain('Also give plan an "overview"')
    expect(a).toContain('Focus on finding a bug')
    // The paragraph is its own pure text; an overview with no source counts as none.
    expect(overviewText({ src, written: Date.UTC(2026, 9, 14) })).toContain('drawn Oct 14, 2026')
    expect(overviewText({ src: '', written: 1 })).toBe(overviewText(null))
    expect(shortDate(Date.UTC(2025, 0, 3))).toBe('Jan 3, 2025')
  })

  test('the submitted prompt carries the focus', () => {
    expect(promptFor('bugs', 'the resume path')).toBe('Walk me through the resume path with a bugs focus.')
    expect(promptFor('general', 'x')).toBe('Walk me through x.')
  })
})

describe('requests from the web page', () => {
  const lines = [
    JSON.stringify({ kind: 'hold', text: '', step: 3, heading: 'Locks' }),
    'not json',
    JSON.stringify({ kind: 'question', via: 'voice', text: ' What if it is missing? ', step: '9', heading: 'Three wires' }),
    JSON.stringify({ kind: 'advance', text: '', step: 4 }),
  ].join('\n')

  test('only lines after the ones seen are read; a broken line is skipped', () => {
    expect(requestsOf(lines, 0)).toEqual({
      requests: [
        { kind: 'hold', text: '', step: 3, heading: 'Locks' },
        { kind: 'question', text: 'What if it is missing?', step: 9, heading: 'Three wires' },
        { kind: 'advance', text: '', step: 4, heading: '' },
      ],
      total: 4,
    })
    expect(requestsOf(lines + '\n', 3)).toEqual({ requests: [{ kind: 'advance', text: '', step: 4, heading: '' }], total: 4 })
    expect(requestsOf('', 7)).toEqual({ requests: [], total: 0 })
  })

  test('a question is to be answered as an aside; Hold is said mid-turn only', () => {
    const { requests } = requestsOf(lines, 0)
    const mid = pageRequestsText(requests, false)
    expect(mid).toContain('at stop 3 ("Locks"), the person pressed Hold')
    expect(mid).toContain('at stop 9 ("Three wires"), the person asked: "What if it is missing?"')
    expect(mid).toContain('call mcp__cosight__show with "ask"')
    expect(mid).toContain('show stop 5')
    const idle = pageRequestsText(requests, true)
    expect(idle).not.toContain('Hold')
    expect(idle).toContain('What if it is missing?')
    expect(pageRequestsText(requestsOf(lines, 0).requests.slice(0, 1), true)).toBe('')
  })
})

describe('readingStatus', () => {
  test('names the file, the pattern or the kind of work, and nothing for other tools', () => {
    expect(readingStatus('Read', { file_path: '/home/me/proj/hooks/tour.ts' })).toBe('Reading hooks/tour.ts')
    expect(readingStatus('Grep', { pattern: 'OutboxEventPublisher' })).toBe('Searching for OutboxEventPublisher')
    expect(readingStatus('Glob', { pattern: '**/*.java' })).toBe('Looking for **/*.java')
    expect(readingStatus('Bash', { command: 'ls' })).toBe('Running a command')
    expect(readingStatus('Agent', { description: 'Find the callers' })).toBe('Exploring: Find the callers')
    expect(readingStatus('mcp__cosight__show', { file: 'x' })).toBe('')
    expect(readingStatus('Edit', { file_path: 'x' })).toBe('')
  })
})

describe('asides and focus', () => {
  test('the ask keeps asides to page questions, sends terminal talk to the terminal and new questions to plan', () => {
    const a = askFor('general')
    expect(a).toContain('Asides are only for questions asked on the tour page')
    expect(a).toContain('What the person types in the terminal is answered in the terminal')
    expect(a).toContain('call mcp__cosight__plan again')
    expect(a).toContain('so the page can pan to the box the voice is talking about')
    expect(a).toContain('short plain id')
    expect(INPUT_SCHEMA.properties.focus.type).toBe('array')
    expect(INPUT_SCHEMA.properties.focus.description).toContain('so the page can pan to the box the voice is talking about')
  })

  test('claimAsk takes the question named, else the oldest open one; with none open only a repeat passes', () => {
    const open = [{ text: 'Why two locks?', isAnswered: false }, { text: 'What is a gate?', isAnswered: false }]
    expect(claimAsk(open, 'what is a gate')).toEqual([open[0], { text: 'What is a gate?', isAnswered: true }])
    expect(claimAsk(open, 'Something else')).toEqual([{ text: 'Why two locks?', isAnswered: true }, open[1]])
    const done = [{ text: 'Why two locks?', isAnswered: true }]
    expect(claimAsk(done, 'why  two locks')).toEqual(done)
    expect(claimAsk(done, 'go')).toBeNull()
    expect(claimAsk([], 'good')).toBeNull()
  })

  test('focusOf trims strings and blanks anything else', () => {
    expect(focusOf([' a ', 3, null, 'b'])).toEqual(['a', '', '', 'b'])
    expect(focusOf('a')).toEqual([])
  })
})

describe('historyText', () => {
  test('numbers the tours, aligns the numbers, cuts a long question, marks the live one, says how to reopen', () => {
    const t = (question: string, stops: number, answers: number, isLive = false) => ({ ms: Date.UTC(2026, 9, 19), question, stops, answers, isLive })
    const entries = [t('What does the poll do?', 1, 1, true), ...Array.from({ length: 9 }, () => t('x'.repeat(70), 8, 14))]
    const lines = historyText(entries).split('\n')
    expect(lines[0]).toBe(' 1  Oct 19, 2026  What does the poll do?  (1 stop, 1 answer) (on the page)')
    expect(lines[9]).toBe(`10  Oct 19, 2026  ${'x'.repeat(59)}…  (8 stops, 14 answers)`)
    expect(lines.at(-1)).toBe('/tour history <n> reopens one on the page.')
    expect(historyText([])).toContain('no tours kept yet')
    expect(HISTORY_MAX).toBe(30)
  })
})
