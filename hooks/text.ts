// Everything the model or the person reads from this plugin.
import type { WindowName, WindowState } from '../types'
import { MARKERS, formatDuration, formatTime } from './core'

export type NoteContext = {
  name: WindowName
  state: WindowState
  now: number
  sessionId: string
  handoffPath: string
}

const LABEL: Record<WindowName, string> = { '5h': '5-hour', '7d': '7-day' }

export function windowLine(name: WindowName, s: WindowState, now: number): string {
  const reset = s.resetsAt === null ? 'reset time unknown' : `resets ${formatTime(s.resetsAt)} (in ${formatDuration(s.resetsAt - now)})`
  return `${LABEL[name]} window at ${s.pct}%, ${reset}`
}

/** The main session's wind-down note: WARN and HARD differ only in urgency. */
export function mainNote(c: NoteContext): string {
  const isHard = c.state.band === 'hard'
  const resetAt = c.state.resetsAt === null ? 'the reset' : formatTime(c.state.resetsAt)
  return [
    `[usage-guard] ${isHard ? 'Usage limit almost reached' : 'Usage limit approaching'}: ${windowLine(c.name, c.state, c.now)}.`,
    isHard
      ? 'Stop now. Make no further tool calls except to leave a half-done edit consistent. New subagents, workflows and loop wakeups are denied from here on.'
      : 'Wind down: finish only the step you are on and start nothing new (no new subagents, workflows or loops).',
    '',
    '1. If a /loop or ralph loop is active, stop it (ScheduleWakeup with stop: true, or /ralph-loop:cancel-ralph). Running subagents were told to return what they have; use what arrives, do not wait long.',
    `2. End your turn with a handoff between these exact marker lines. usage-guard saves it to ${c.handoffPath}; do not write that file yourself.`,
    MARKERS.START,
    '# Handoff',
    '## Goal',
    '## Done',
    '## In flight (including subagent results not yet used)',
    '## Next steps (ordered)',
    '## Key files and commands',
    `## Resume: claude --resume ${c.sessionId} after ${resetAt}`,
    MARKERS.END,
    `3. After the handoff, tell the user in one line: resume with \`claude --resume ${c.sessionId}\` after ${resetAt}.`,
    '',
    'Do not commit, push or change git state as part of this.',
  ].join('\n')
}

/** What a running subagent is told. */
export function subagentNote(c: Pick<NoteContext, 'name' | 'state' | 'now'>): string {
  return [
    `[usage-guard] Usage limit near: ${windowLine(c.name, c.state, c.now)}.`,
    'Stop after the step you are on and return now, compactly: the results you have, and what is unfinished. Start no new subagents or workflows. Do not change git state.',
  ].join('\n')
}

/** Appended to every subagent's prompt at spawn. */
export const SPAWN_CONTRACT = [
  '',
  '',
  '---',
  'usage-guard: return your results compactly. If a [usage-guard] message says usage is near the limit, stop after your current step and return what you have, marking what is unfinished.',
].join('\n')

export function resumePrompt(handoffPath: string): string {
  return `[usage-guard] The usage limit has reset. Continue the work from the handoff at ${handoffPath} (read it first if it is not in context). Restart any /loop or ralph loop you stopped for the limit.`
}

export function stopFailureNotice(sessionId: string, handoffPath: string, resetText: string): string {
  return `usage-guard: rate limit hit. Resume with: claude --resume ${sessionId} ${resetText}. Handoff: ${handoffPath}`
}

export function stubHandoff(c: { sessionId: string; lastPrompt: string; lastAnswer: string; resetText: string }): string {
  return [
    '# Handoff (stub written by usage-guard after the rate limit hit)',
    '',
    'The session stopped before it could write its own handoff.',
    '',
    '## Last user prompt',
    c.lastPrompt || '(none)',
    '',
    '## Last assistant text',
    c.lastAnswer || '(none)',
    '',
    `## Resume: claude --resume ${c.sessionId} ${c.resetText}`,
    '',
  ].join('\n')
}
