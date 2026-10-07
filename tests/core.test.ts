import { expect, test } from 'claude-code/testing'

import { DOWNGRADE_MS, classify, extractHandoff, formatDuration, maxBand, msToEmpty, noticeKey, parseSimulate, slug } from '../hooks/core'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const MIN = 60_000
const T = { warn: 85, hard: 95 }
const at = (min: number) => NOW + min * MIN
const reading = (pct: number, resetInMin = 120) => ({ kind: 'five_hour', percentUsed: pct, resetsAt: new Date(NOW + resetInMin * MIN).toISOString() })

test('thresholds pick the band', () => {
  expect(classify(undefined, reading(50), NOW, T).band).toBe('ok')
  expect(classify(undefined, reading(85), NOW, T).band).toBe('warn')
  expect(classify(undefined, reading(95), NOW, T).band).toBe('hard')
})

test('a passed reset time means ok and an empty window', () => {
  const s = classify(undefined, reading(99, -1), NOW, T)
  expect(s).toEqual({ band: 'ok', pct: 0, resetsAt: null, samples: [], belowSince: null })
  const hard = classify(undefined, reading(99, 10), NOW, T)
  expect(classify(hard, undefined, at(11), T).band).toBe('ok')
})

test('a fast burn escalates one band', () => {
  // 70% -> 80% in 5 min: 2%/min, 20% left = 10 min to empty, reset in 120 min.
  const a = classify(undefined, reading(70), NOW, T)
  const b = classify(a, reading(80), at(5), T)
  expect(b.band).toBe('warn')
  expect(msToEmpty(b.samples, 80)).toBe(10 * MIN)
  // 80% -> 90% in 2 min: 10 left at 5%/min = 2 min, warn escalates to hard.
  const c = classify(b, reading(90), at(7), T)
  expect(c.band).toBe('hard')
})

test('no escalation when the window resets before it would empty', () => {
  const a = classify(undefined, reading(70, 6), NOW, T)
  const b = classify(a, reading(80, 1), at(5), T)
  expect(b.band).toBe('ok')
})

test('a downgrade waits for the debounce', () => {
  const warn = classify(undefined, reading(86), NOW, T)
  const dip = classify(warn, reading(80), at(1), T)
  expect(dip.band).toBe('warn')
  expect(dip.belowSince).toBe(at(1))
  const later = classify(dip, reading(80), at(1) + DOWNGRADE_MS, T)
  expect(later.band).toBe('ok')
})

test('a new window cycle starts the history over', () => {
  const a = classify(undefined, reading(90, 10), NOW, T)
  const b = classify(a, reading(5, 300), at(1), T)
  expect(b.band).toBe('ok')
  expect(b.samples.length).toBe(1)
})

test('helpers', () => {
  expect(maxBand(['ok', 'hard', 'warn'])).toBe('hard')
  expect(noticeKey('5h', classify(undefined, reading(86), NOW, T))).toBe(`5h:warn:${NOW + 120 * MIN}`)
  expect(formatDuration(72 * MIN)).toBe('1h 12m')
  expect(formatDuration(3 * 1440 * MIN + 5 * 60 * MIN)).toBe('3d 5h')
  expect(extractHandoff('x <!-- usage-guard:handoff -->\n# H\n<!-- /usage-guard:handoff --> y')).toBe('# H')
  expect(extractHandoff('no markers')).toBe(null)
  expect(slug('/Users/me/My Repo/')).toBe('My-Repo')
  expect(parseSimulate(['5h', '96', 'reset-in', '2m'], NOW)).toEqual({ kind: 'five_hour', percentUsed: 96, resetsAt: new Date(NOW + 2 * MIN).toISOString() })
  expect(parseSimulate(['5h', 'abc'], NOW)).toBe(null)
  expect(parseSimulate(['1d', '50'], NOW)).toBe(null)
})
