# usage-guard: plan

A Claude Code function-hook mod (Claude Code >= 2.1.287, verified against the 2.1.292 typings) that winds sessions and subagents down cleanly before the 5-hour or 7-day subscription limit, writes a handoff, and optionally resumes after the reset.

## Feasibility (verified against `claude-code.d.ts`, 2.1.292)

| Spec item | Verdict | API |
| --- | --- | --- |
| 1. Usage signal | Feasible, better than drafted. Polling is unnecessary: the engine pushes `session.measure` after each main turn and whenever a window moves a whole point. Not tied to the statusline. **Phase 0 result: headless `claude -p` gets empty `rateLimits` (both the event and `$.session.usage()`), so the guard is interactive-only.** | `on('session.measure')`, `$.session.usage()` once at `session.start` |
| 2. Per-model limits | Not exposed. `kind` is `five_hour`, `seven_day` or a gateway's `spend_limit`. Dropped. | `SessionRateLimit` |
| 3. WARN note | Feasible. A `type: "user"` row is read by the model from the loop's next top, so it lands mid-turn. | `$.session.append({ message })` |
| 4. HARD deny | Feasible. | `on('tool.call', { tool }, () => ({ deny }))` |
| 5. Running subagents | Feasible. A row can be appended into a running subagent's conversation by id. | `$.session.append({ message, agentId })`, ids from `agent.spawn` result and `$.agent.list()` |
| 6. After reset | Correction: an idle session gets no `session.measure`, so reset is detected by a clock timer at `resetsAt`. An appended row does not wake an idle session; `$.prompt.submit` does (queued until idle). | `$.clock`, `$.prompt.submit` |
| Limit actually hit | Model cannot write a handoff once the API refuses. Plugin can still react. | `on('classic.StopFailure')`, `error === 'rate_limit'` |
| Testing | Ops are hookable beneath the plugin in tests, so usage is fakeable without burning quota. | `claude-code/testing`: `on('session.usage', () => ({ value }))`, `$.session.measure(...)`, `mock.clock`, `$.tool.call`, `$.classic.StopFailure` |

## Decisions

1. **Thresholds**: WARN 5h 85 / 7d 90, HARD 5h 95 / 7d 97, all in `userConfig`. Escalate one band if the projected burn empties the window before reset with less than 30 min (WARN) or 10 min (HARD) to go. Downgrade only after 3 min below the threshold.
2. **Handoff location**: `~/.claude/handoffs/<project-slug>-<session-id>.md`. Claude prints the handoff in its final answer between `<!-- usage-guard:handoff -->` markers; the plugin extracts it on `turn.complete` and saves it with `$.fs.write`. No Write tool call, so no permission prompt and no sandbox issue for colleagues.
3. **HARD scope**: deny `Agent`, `Workflow`, `ScheduleWakeup`, `CronCreate` (main and subagents). Append a "return what you have now" row to every running subagent. Never deny Edit, Write, Bash.
4. **After reset**: `autoResume` in `userConfig`, default `false`. When on, and only in a session the guard stopped, a timer at `resetsAt` plus 0 to 5 min random jitter calls `$.prompt.submit` once. When off, toast + band "limit restored, type continue".
5. **Testing**: `claude plugin test` with faked `session.usage` / `session.measure` and `mock.clock`, plus `/usage-guard simulate <5h|7d> <pct> [reset-in <dur>]` for live checks, session-local, `simulate off` to restore.

Hard constraints (unchanged): no git instructions, no `settings.json` or statusline edits, no auto-approve, warn once per band, no network, `type` not `interface`, pnpm.

## Repo layout (single-plugin marketplace)

```
usage-guard/
  .claude-plugin/
    plugin.json          # name, version, description, userConfig, "types"
    marketplace.json     # { name, owner, plugins: [{ name: "usage-guard", source: "./" }] }
  hooks/
    hooks.json           # { "modules": ["./register.tsx"] }
    register.tsx         # wiring only: events -> core -> effects
    core.ts              # pure: classify(readings, now, config, prev) -> band state
    text.ts              # note, contract and handoff templates
  types/
    index.d.ts           # PluginState contract for $.state
  tests/
    core.test.ts         # pure band logic
    text.test.ts         # every note and template
    guard.test.tsx       # engine-level: warn, hard, subagents, spawn, reset, autoResume, command, StopFailure
  research/prior-art.md
  PLAN.md
  README.md              # install: /plugin install usage-guard --marketplace <owner>/usage-guard
  package.json           # pnpm scripts: validate, test, typecheck
```

`core.ts` has no `$`: every band decision is a pure function so most tests need no engine.

## Phases (tracer bullets)

Each phase ships end to end and ends with its verify step. Run `claude plugin validate .` and `claude plugin test .` after every phase.

### Phase 0: skeleton + headless spike (about 1 h)
- Files above with an empty `register` that logs each `session.measure` `rateLimits` to `$.ui.log`.
- Load with `claude --plugin-dir .`.
- **Verify**: `claude plugin validate .` clean. Interactive session shows `five_hour` and `seven_day` readings after one prompt. `claude -p "say hi" --plugin-dir .` shows the same (proves the headless claim; if empty, record it in README as a known limit).

### Phase 1: band state + display (about 2 h)
- `core.classify`: per window band `ok | warn | hard`, burn-rate escalation from the last readings, 3 min downgrade debounce, stale or empty data returns `ok` (silence). A reading whose `resetsAt` is in the past counts as reset.
- Band above the prompt (`AbovePrompt`) with % and countdown when not `ok`; `$.clock.every(60_000)` only to redraw the countdown.
- **Verify**: `core.test.ts` covers thresholds, escalation, debounce, empty, past `resetsAt`. A test overriding `session.usage` and dispatching `session.measure` asserts the band tree.

### Phase 2: WARN in the main session (about 2 h)
- On entry into `warn` (or `hard`) for a window, once per `(window, resetsAt)` in `$.state`: append the wind-down note (finish current step, start nothing new, stop any `/loop` or ralph loop, print handoff between markers, include `claude --resume <id>` and reset time, end the turn, no git).
- `turn.complete` (main, no `agentId`): extract marked block, `$.fs.write` to the handoff path, toast the path.
- **Verify**: `warn.test.ts`: three `measure` events at 86/87/88 produce exactly one append; a new `resetsAt` re-arms. Handoff extraction writes the expected path (fs mocked or asserted via the test's `on('fs.write')`).

### Phase 3: subagents (about 2 h)
- `agent.spawn`: append the contract to `prompt` (return compactly; on a usage-guard note, stop and return what you have). Track ids from the spawn result.
- On band entry: also append the note to every running subagent (`$.agent.list()` filtered to running, cross-checked with tracked ids).
- **Verify**: `subagents.test.ts`: spawn prompt carries the contract; a `measure` at 86 with two running agents yields one append per `agentId`. Live: `/usage-guard simulate 5h 86` during an Explore agent, agent returns early.

### Phase 4: HARD (about 1 h)
- `tool.call` deny for `Agent`, `Workflow`, `ScheduleWakeup`, `CronCreate` while any window is `hard`, with reason naming the reset time; one toast per band entry.
- **Verify**: `hard.test.ts` via `$.tool.call`: denied in `hard`, allowed in `warn`, `Edit` never denied.

### Phase 5: `/usage-guard` command (about 1 h)
- `status` (windows, bands, reset times, handoff path), `on`, `off` (session-local in `$.state`), `simulate <5h|7d> <pct> [reset-in <dur>]`, `simulate off`. Simulated readings feed the same `classify` path.
- **Verify**: command tests assert text output; live run of `simulate 5h 96 reset-in 2m` shows band, denies Agent, then restores after 2 min.

### Phase 6: reset + autoResume (about 2 h)
- Timer per window at `resetsAt`. On fire: clear that window's dedupe, toast "limit restored". If `autoResume` and this session was stopped by the guard: after 0 to 5 min jitter, `$.prompt.submit` once ("limit restored, continue from <handoff path>").
- **Verify**: `reset.test.ts` with `mock.clock`: advance past `resetsAt`, dedupe cleared; `autoResume: false` submits nothing; `true` submits exactly once within the jitter window; a session never stopped submits nothing.

### Phase 7: StopFailure fallback (about 1 h)
- `classic.StopFailure` with `error === 'rate_limit'`: system notice + toast with `claude --resume <id>` and reset time; if no handoff exists yet, write a stub handoff (last user prompt, last assistant text, resume command) from `$.session.messages()`.
- **Verify**: `stopfailure.test.ts` via `$.classic.StopFailure`; stub written only when absent.

### Phase 8: share (about 1 h)
- README (install line, config table, what it never does), version 0.1.0, push to GitHub.
- **Verify**: in a clean `CLAUDE_CONFIG_DIR`, `/plugin install usage-guard --marketplace <owner>/usage-guard` installs and `/usage-guard status` answers.

Total: about 14 h.

## Test strategy

- **Pure**: `core.classify` fed synthetic reading sequences and a fixed `now`. Covers 90 percent of logic.
- **Engine-level** (`claude plugin test`): the test registers `on('session.usage', () => ({ value: fakeUsage }))` beneath the plugin, dispatches `$.session.measure({ context, rateLimits, changed })`, captures `on('session.append')`, `on('prompt.submit')`, `on('ui.toast')` (or the matching op names in the typings), drives `$.tool.call` for denies, `mock.clock` for timers, `test(name, { options }, body)` for `userConfig`.
- **Live**: `/usage-guard simulate` in a real session with real subagents; no quota burned.

## Open risks

- **Headless readings**: verified empty in `claude -p` on 2.1.292; documented in README.
- **Test kit**: `claude plugin test` never hands `$.session.append` to a test hook (2.1.289+), so engine tests count notes by the plugin's `$.ui.log` line for an undelivered append, and note text is tested as pure functions.
- **ralph** re-feeds via a settings Stop hook; the note asks Claude to run `/ralph-loop:cancel-ralph`, the mod cannot cancel it directly.
- **Compliance**: the model may ignore the note mid-tool chain; HARD denies cap the damage but cannot stop plain tool loops.
- **API churn**: mods are early access; pin `>= 2.1.287` and re-run `claude plugin validate` on each Claude Code update.
- **Workflow agents**: `agent.spawn` fires for them too, but deny on `Workflow` only stops new runs; running ones get the append like other subagents.
