// usage-guard: winds the session and its subagents down before a subscription
// limit. Readings arrive pushed by `session.measure`; core.ts decides the band,
// this module turns band entries into one note each, denies, and the band UI.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Band, Reading, WindowName, WindowState } from '../types'
import { classify, extractHandoff, formatDuration, formatTime, maxBand, noticeKey, parseSimulate, slug, windowOf } from './core'
import type { Config } from './core'
import { SPAWN_CONTRACT, mainNote, resumePrompt, stopFailureNotice, stubHandoff, subagentNote, windowLine } from './text'

const live = atom({ plugin: 'usage-guard', key: 'live' } as const, [] as Reading[])
const simulated = atom({ plugin: 'usage-guard', key: 'simulated' } as const, null as Reading[] | null)
const windows = atom({ plugin: 'usage-guard', key: 'windows' } as const, {} as Partial<Record<WindowName, WindowState>>)
const notified = atom({ plugin: 'usage-guard', key: 'notified' } as const, [] as string[])
const isStopped = atom({ plugin: 'usage-guard', key: 'isStopped' } as const, false)
const isOff = atom({ plugin: 'usage-guard', key: 'isOff' } as const, false)
const restoredAt = atom({ plugin: 'usage-guard', key: 'restoredAt' } as const, null as number | null)
const tick = atom({ plugin: 'usage-guard', key: 'tick' } as const, 0)

const NAMES: WindowName[] = ['5h', '7d']
/** Tools denied while any window is HARD: new work and loop wakeups, never edits. */
export const HARD_DENY = new Set(['Agent', 'Workflow', 'ScheduleWakeup', 'CronCreate'])
const DONE = new Set(['completed', 'failed', 'killed'])
const TICK_MS = 60_000
/** autoResume waits a random 0 to 5 min so parallel sessions do not wake together. */
export const JITTER_MS = 5 * 60_000
/** How long the band says "restored" after a reset. */
const RESTORED_SHOW_MS = 10 * 60_000

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function readConfig(o: PluginOptions): Config {
  return {
    thresholds: {
      '5h': { warn: num(o.warn5h, 85), hard: num(o.hard5h, 95) },
      '7d': { warn: num(o.warn7d, 90), hard: num(o.hard7d, 97) },
    },
    autoResume: o.autoResume === true,
  }
}

async function handoffPath($: EngineInterface): Promise<string> {
  const [home, root, id] = await Promise.all([$.env.get('HOME').catch(() => undefined), $.session.root(), $.session.id()])
  const dir = home ? `${home}/.claude/handoffs` : `${root}/.claude/handoffs`
  return `${dir}/${slug(root)}-${id}.md`
}

function textRow(text: string) {
  return { type: 'text' as const, text }
}

/** Appends a row to main (no agentId) or a running subagent; a refusal is logged, never thrown. */
async function appendRow($: EngineInterface, type: 'user' | 'system', text: string, agentId?: string): Promise<void> {
  try {
    await $.session.append({ message: { type, content: [textRow(text)] }, ...(agentId ? { agentId } : {}) })
  } catch (err) {
    $.ui.log(`usage-guard: note to ${agentId ?? 'main'} not delivered: ${String(err)}`)
  }
}

async function overall($: EngineInterface): Promise<Band> {
  const w = await read($, windows)
  return maxBand(NAMES.map(n => w[n]?.band ?? 'ok'))
}

async function announce($: EngineInterface, name: WindowName, state: WindowState): Promise<void> {
  const now = await $.clock.now()
  const [sessionId, path] = await Promise.all([$.session.id(), handoffPath($)])
  const ctx = { name, state, now, sessionId, handoffPath: path }
  await appendRow($, 'user', mainNote(ctx))
  const agents = await $.agent.list().catch(() => [])
  for (const a of agents) {
    if (DONE.has(a.status) || a.status === 'idle') continue
    await appendRow($, 'user', subagentNote(ctx), a.id)
  }
  $.ui.toast(`usage-guard: ${state.band.toUpperCase()}, ${windowLine(name, state, now)}`)
  await update($, isStopped, () => true)
}

async function onReset($: EngineInterface, config: Config, name: WindowName): Promise<void> {
  const kind = name === '5h' ? 'five_hour' : 'seven_day'
  await update($, notified, keys => keys.filter(k => !k.startsWith(`${name}:`)))
  await update($, simulated, s => {
    const left = s?.filter(r => r.kind !== kind) ?? []
    return left.length > 0 ? left : null
  })
  if (!(await read($, isStopped)) || (await overall($)) !== 'ok') return
  await update($, isStopped, () => false)
  const now = await $.clock.now()
  await update($, restoredAt, () => now)
  $.ui.toast(`usage-guard: ${name} limit restored`)
  if (!config.autoResume || (await read($, isOff))) return
  const path = await handoffPath($)
  $.clock.after(Math.floor(Math.random() * JITTER_MS), () => {
    void $.prompt.submit({ text: resumePrompt(path) })
  })
}

/** Folds fresh readings (or none, on a tick) into the windows and acts on band entries. */
async function evaluate($: EngineInterface, config: Config, fresh: readonly Reading[] | null): Promise<void> {
  const now = await $.clock.now()
  const readings = (await read($, simulated)) ?? fresh
  const prev = await read($, windows)
  const next: Partial<Record<WindowName, WindowState>> = {}
  for (const name of NAMES) {
    const reading = readings?.find(r => windowOf(r.kind) === name)
    if (!reading && !prev[name]) continue
    next[name] = classify(prev[name], reading, now, config.thresholds[name])
  }
  await update($, windows, () => next)
  await update($, tick, () => now)

  for (const name of NAMES) {
    const was = prev[name]
    const is = next[name]
    if (was?.resetsAt != null && is && (is.resetsAt === null || is.resetsAt > was.resetsAt + 60_000)) await onReset($, config, name)
  }
  if (await read($, isOff)) return
  for (const name of NAMES) {
    const s = next[name]
    if (!s || s.band === 'ok') continue
    const key = noticeKey(name, s)
    if ((await read($, notified)).includes(key)) continue
    await update($, notified, keys => [...keys, key])
    await announce($, name, s)
  }
}

async function status($: EngineInterface, config: Config): Promise<string> {
  const now = await $.clock.now()
  const w = await read($, windows)
  const lines = NAMES.flatMap(n => {
    const s = w[n]
    return s ? [`${n}: ${s.band.toUpperCase()}, ${windowLine(n, s, now)}`] : []
  })
  const sim = await read($, simulated)
  return [
    `usage-guard ${(await read($, isOff)) ? 'off' : 'on'} for this session${sim ? ' (simulated readings)' : ''}`,
    ...(lines.length > 0 ? lines : ['no rate-limit readings yet (none before the first response, none off a subscription)']),
    `wind-down sent: ${(await read($, isStopped)) ? 'yes' : 'no'}`,
    `autoResume: ${config.autoResume ? 'on' : 'off'}`,
    `handoff: ${await handoffPath($)}`,
  ].join('\n')
}

export const register: Register = (on, options) => {
  const config = readConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-guard',
      description: 'Usage guard: status, on, off, simulate <5h|7d> <pct> [reset-in <n>(s|m|h|d)], simulate off',
      argumentHint: '[status|on|off|simulate]',
    })
    const usage = await $.session.usage().catch(() => null)
    await evaluate($, config, usage && usage.rateLimits.length > 0 ? usage.rateLimits : null)
    $.clock.every(TICK_MS, () => {
      void evaluate($, config, null)
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) {
      await update($, live, () => [...e.rateLimits])
      await evaluate($, config, e.rateLimits)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (!HARD_DENY.has(e.tool) || (await read($, isOff)) || (await overall($)) !== 'hard') return next(e)
    const w = await read($, windows)
    const resets = NAMES.flatMap(n => (w[n]?.band === 'hard' && w[n]?.resetsAt != null ? [w[n]!.resetsAt!] : []))
    const when = resets.length > 0 ? ` until ${formatTime(Math.max(...resets))}` : ''
    return { deny: `usage-guard: usage limit almost reached, ${e.tool} is paused${when}. Finish the current step and write the handoff.` }
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    if (await read($, isOff)) return next(e)
    return next({ ...e, prompt: e.prompt + SPAWN_CONTRACT })
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // Only a session this plugin asked for a handoff saves one: markers quoted anywhere else are ignored.
    if (e.agentId === undefined && (await read($, isStopped))) {
      const body = extractHandoff(e.answer)
      if (body !== null) {
        const path = await handoffPath($)
        await $.fs.write(path, `${body}\n`)
        $.ui.toast(`usage-guard: handoff saved to ${path}`)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.StopFailure', async ($, e, next) => {
    if (e.error !== 'rate_limit') return next(e)
    const [sessionId, path] = await Promise.all([$.session.id(), handoffPath($)])
    const w = await read($, windows)
    const resets = NAMES.flatMap(n => (w[n]?.resetsAt != null ? [w[n]!.resetsAt!] : []))
    const resetText = resets.length > 0 ? `after ${formatTime(Math.max(...resets))}` : 'after the limit resets'
    if (!(await $.fs.exists(path))) {
      const messages = await $.session.messages().catch(() => [])
      const list = Array.isArray(messages) ? messages : []
      const lastPrompt = [...list].reverse().find(m => m.role === 'user')?.text ?? ''
      const lastAnswer = e.last_assistant_message ?? [...list].reverse().find(m => m.role === 'assistant')?.text ?? ''
      await $.fs.write(path, stubHandoff({ sessionId, lastPrompt, lastAnswer, resetText }))
    }
    const notice = stopFailureNotice(sessionId, path, resetText)
    await appendRow($, 'system', notice)
    $.ui.toast(notice)
    await update($, isStopped, () => true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'usage-guard' }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    const [verb = 'status', ...rest] = args
    if (verb === 'status') return { text: await status($, config) }
    if (verb === 'on' || verb === 'off') {
      await update($, isOff, () => verb === 'off')
      if (verb === 'on') await evaluate($, config, await read($, live))
      return { text: `usage-guard ${verb} for this session` }
    }
    if (verb === 'simulate') {
      if (rest[0] === 'off') {
        await update($, simulated, () => null)
        await update($, windows, () => ({}))
        await update($, notified, () => [])
        await update($, isStopped, () => false)
        await update($, restoredAt, () => null)
        const real = await read($, live)
        await evaluate($, config, real.length > 0 ? real : null)
        return { text: 'usage-guard: simulation off, real readings restored' }
      }
      const reading = parseSimulate(rest, await $.clock.now())
      if (!reading) return { text: 'usage: /usage-guard simulate <5h|7d> <0-100> [reset-in <n>(s|m|h|d)] | simulate off' }
      const merged = [...((await read($, simulated)) ?? []).filter(r => r.kind !== reading.kind), reading]
      await update($, simulated, () => merged)
      await evaluate($, config, merged)
      return { text: await status($, config) }
    }
    return { text: 'usage: /usage-guard [status|on|off|simulate <5h|7d> <pct> [reset-in <dur>]|simulate off]' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, tick)
    const w = await read($, windows)
    const restored = await read($, restoredAt)
    if (await read($, isOff)) return next(e)
    const rows = NAMES.flatMap(n => {
      const s = w[n]
      return s && s.band !== 'ok' ? [{ n, s }] : []
    })
    const isRestored = rows.length === 0 && restored !== null && now - restored < RESTORED_SHOW_MS
    if (rows.length === 0 && !isRestored) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    if (isRestored) {
      return (
        <Box>
          <Text color="success">usage-guard: limit restored</Text>
        </Box>
      )
    }
    return (
      <Box>
        {rows.map(({ n, s }) => (
          <Text key={n} color={s.band === 'hard' ? 'error' : 'warning'}>
            {`usage-guard ${n} ${s.pct}% ${s.band.toUpperCase()}${s.resetsAt === null ? '' : `, resets in ${formatDuration(s.resetsAt - now)}`}  `}
          </Text>
        ))}
      </Box>
    )
  })
}
