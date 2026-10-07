export type Band = 'ok' | 'warn' | 'hard'

export type WindowName = '5h' | '7d'

/** One rate-limit window as the engine reports it (`SessionRateLimit`). */
export type Reading = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * One window's band, its last percent, when it resets (ms, null when unknown),
 * the recent readings the burn rate is drawn from, and since when a lower band
 * has held (the downgrade debounce).
 */
export type WindowState = {
  band: Band
  pct: number
  resetsAt: number | null
  samples: { at: number; pct: number }[]
  belowSince: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-guard': {
      /** The last real readings the engine reported. */
      live: Reading[]
      /** Readings `/usage-guard simulate` set; they replace `live` while set. */
      simulated: Reading[] | null
      windows: Partial<Record<WindowName, WindowState>>
      /** Dedupe keys of the band entries already announced (core.noticeKey). */
      notified: string[]
      /** True once this session was told to wind down, until a reset. */
      isStopped: boolean
      /** `/usage-guard off` for this session. */
      isOff: boolean
      /** When a window last reset after a wind-down, for the band; null otherwise. */
      restoredAt: number | null
      /** The clock as the band last read it, so the countdown redraws. */
      tick: number
    }
  }
}
