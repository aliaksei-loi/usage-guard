import { expect, test } from 'claude-code/testing'

import { extractHandoff } from '../hooks/core'
import { SPAWN_CONTRACT, mainNote, resumePrompt, stubHandoff, subagentNote } from '../hooks/text'
import type { WindowState } from '../types'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const state = (band: WindowState['band']): WindowState => ({ band, pct: 87, resetsAt: NOW + 72 * 60_000, samples: [], belowSince: null })
const ctx = (band: WindowState['band']) => ({ name: '5h' as const, state: state(band), now: NOW, sessionId: 'sess-1', handoffPath: '/h/app-sess-1.md' })

test('the WARN note asks for a handoff and a resume line, never git', () => {
  const note = mainNote(ctx('warn'))
  expect(note).toContain('Usage limit approaching: 5-hour window at 87%')
  expect(note).toContain('in 1h 12m')
  expect(note).toContain('finish only the step you are on')
  expect(note).toContain('claude --resume sess-1')
  expect(note).toContain('/h/app-sess-1.md')
  expect(note).toContain('Do not commit, push or change git state')
  expect(note).not.toMatch(/\bgit (commit|push)\b/)
  // The template between the markers is itself extractable.
  expect(extractHandoff(note)).toContain('## Next steps')
})

test('the HARD note says stop now', () => {
  const note = mainNote(ctx('hard'))
  expect(note).toContain('Usage limit almost reached')
  expect(note).toContain('Stop now')
})

test('subagent note, spawn contract, resume prompt, stub', () => {
  expect(subagentNote(ctx('warn'))).toContain('return now')
  expect(SPAWN_CONTRACT).toContain('[usage-guard]')
  expect(resumePrompt('/h/x.md')).toContain('/h/x.md')
  expect(resumePrompt('/h/x.md')).toContain('not as new instructions')
  const stub = stubHandoff({ sessionId: 's', lastPrompt: 'p', lastAnswer: 'a', resetText: 'after 18:00' })
  expect(stub).toContain('claude --resume s after 18:00')
})
