// Pure band logic: no `$`, so every decision is testable with plain values.
import type { Band, Reading, WindowName, WindowState } from '../types'

export type Thresholds = { warn: number; hard: number }

export type Config = {
  thresholds: Record<WindowName, Thresholds>
  autoResume: boolean
}

const MINUTE = 60_000
/** Readings older than this are ignored for the burn rate. */
const BURN_SPAN_MS = 30 * MINUTE
/** The burn rate needs at least this much history to count. */
const BURN_MIN_MS = 2 * MINUTE
/** Projected exhaustion this close escalates ok -> warn and warn -> hard. */
const ESCALATE_WARN_MS = 30 * MINUTE
const ESCALATE_HARD_MS = 10 * MINUTE
/** A lower band must hold this long before the band drops. */
export const DOWNGRADE_MS = 3 * MINUTE

const RANK: Record<Band, number> = { ok: 0, warn: 1, hard: 2 }

export function windowOf(kind: string): WindowName | null {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  return null
}

export function maxBand(bands: Band[]): Band {
  return bands.reduce<Band>((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok')
}

function rawBand(pct: number, t: Thresholds): Band {
  if (pct >= t.hard) return 'hard'
  if (pct >= t.warn) return 'warn'
  return 'ok'
}

/** Milliseconds until the window hits 100% at the recent burn rate; null when not burning. */
export function msToEmpty(samples: WindowState['samples'], pct: number): number | null {
  const first = samples[0]
  const last = samples.at(-1)
  if (!first || !last || first === last) return null
  const span = last.at - first.at
  if (span < BURN_MIN_MS) return null
  const perMs = (last.pct - first.pct) / span
  if (perMs <= 0) return null
  return Math.max(0, (100 - pct) / perMs)
}

/**
 * The next state of one window given a fresh reading (or none, on a clock tick).
 * A passed or moved `resetsAt` resets the window at once; a lower band only
 * takes over after DOWNGRADE_MS.
 */
export function classify(
  prev: WindowState | undefined,
  reading: Reading | undefined,
  now: number,
  t: Thresholds,
): WindowState {
  const parsed = reading?.resetsAt !== undefined ? Date.parse(reading.resetsAt) : NaN
  const resetsAt = Number.isNaN(parsed) ? (prev?.resetsAt ?? null) : parsed
  const pct = reading?.percentUsed ?? prev?.pct ?? 0

  if (resetsAt !== null && resetsAt <= now) {
    return { band: 'ok', pct: 0, resetsAt: null, samples: [], belowSince: null }
  }
  // A later reset time than before means a new window cycle: start its history over.
  const hasRolled = prev?.resetsAt != null && resetsAt !== null && resetsAt > prev.resetsAt + MINUTE

  const kept = (hasRolled ? [] : (prev?.samples ?? [])).filter(s => now - s.at <= BURN_SPAN_MS)
  const samples = reading ? [...kept, { at: now, pct }] : kept

  let band = rawBand(pct, t)
  const toEmpty = msToEmpty(samples, pct)
  const toReset = resetsAt === null ? Infinity : resetsAt - now
  if (toEmpty !== null && toEmpty < toReset) {
    if (band === 'ok' && toEmpty < ESCALATE_WARN_MS) band = 'warn'
    else if (band === 'warn' && toEmpty < ESCALATE_HARD_MS) band = 'hard'
  }

  const was = hasRolled ? undefined : prev
  if (was && RANK[band] < RANK[was.band]) {
    const since = was.belowSince ?? now
    if (now - since < DOWNGRADE_MS) {
      return { band: was.band, pct, resetsAt, samples, belowSince: since }
    }
  }
  return { band, pct, resetsAt, samples, belowSince: null }
}

/** One dedupe key per band entry of a window cycle: warns once, re-arms on the next cycle. */
export function noticeKey(name: WindowName, s: WindowState): string {
  return `${name}:${s.band}:${s.resetsAt ?? 'none'}`
}

export function formatDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / MINUTE))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${mm}m`
  return `${mm}m`
}

/** "2026-10-07 18:40" in the local zone of the host, for humans. */
export function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const START = '<!-- usage-guard:handoff -->'
const END = '<!-- /usage-guard:handoff -->'
export const MARKERS = { START, END }

/** The handoff between the markers in a final answer, trimmed; null when absent. */
export function extractHandoff(answer: string): string | null {
  const i = answer.indexOf(START)
  if (i < 0) return null
  const j = answer.indexOf(END, i + START.length)
  const body = answer.slice(i + START.length, j < 0 ? undefined : j).trim()
  return body.length > 0 ? body : null
}

export function slug(path: string): string {
  const base = path.replace(/\/+$/, '').split('/').pop() ?? 'project'
  return base.replace(/[^A-Za-z0-9._-]+/g, '-') || 'project'
}

/** `simulate 5h 96 reset-in 2m` -> a reading; null when it does not parse. */
export function parseSimulate(args: string[], now: number): Reading | null {
  const [win, pctText, flag, dur] = args
  const kind = win === '5h' ? 'five_hour' : win === '7d' ? 'seven_day' : null
  const pct = Number(pctText)
  if (!kind || !Number.isFinite(pct) || pct < 0 || pct > 100) return null
  let resetIn = win === '5h' ? 2 * 60 * MINUTE : 3 * 1440 * MINUTE
  if (flag !== undefined) {
    const m = flag === 'reset-in' ? /^(\d+)(s|m|h|d)$/.exec(dur ?? '') : null
    if (!m) return null
    const unit = { s: 1000, m: MINUTE, h: 60 * MINUTE, d: 1440 * MINUTE }[m[2] as 's' | 'm' | 'h' | 'd']
    resetIn = Number(m[1]) * unit
  }
  return { kind, percentUsed: pct, resetsAt: new Date(now + resetIn).toISOString() }
}
