# usage-guard

A Claude Code mod that winds your sessions and subagents down before the 5-hour or 7-day subscription limit, so work stops at a clean point with a handoff instead of dying mid-task.

Requires Claude Code 2.1.287 or newer (function-hook mods) and a Claude subscription (the limits are read from the engine; there are none on API keys).

## Install

```
/plugin install usage-guard --marketplace aliaksei-loi/usage-guard
```

Answer `y` to add the marketplace, pick the user scope. It is active at once.

## What it does

| Band | Default | What happens |
| --- | --- | --- |
| WARN | 5h 90% / 7d 90% | One note to the main session and to every running subagent: finish the current step, start nothing new, stop `/loop` or ralph, end the turn with a handoff. A toast and a band above the prompt with % and countdown. |
| HARD | 5h 95% / 7d 97% | A second, stricter note, and `Agent`, `Workflow`, `ScheduleWakeup`, `CronCreate` are denied until the reset. Edits, writes and Bash are never denied. |
| Reset | | Toast and band "limit restored". With `autoResume` on, sessions it wound down get one "continue from the handoff" prompt after a random 0 to 5 min delay. |
| Limit hit anyway | | On a `rate_limit` stop failure it writes a stub handoff (if none exists) and prints the `claude --resume` line. |

Each note fires once per band entry per window cycle, not on every tool call. A band drops only after 3 minutes below its threshold. No readings (off a subscription, before the first response) means silence.

Subagents get a short contract appended to their prompt at spawn, and the wind-down note is appended straight into each running subagent's conversation.

### Handoff

Claude prints the handoff between `<!-- usage-guard:handoff -->` markers at the end of its turn; the plugin saves it to

```
~/.claude/handoffs/<project>-<session-id>.md
```

The plugin writes the file itself, so there is no permission prompt and nothing lands in your repo. Resume with `claude --resume <session-id>` after the reset time (the note and the toast print both).

## Command

```
/usage-guard                                  status: windows, bands, reset times, handoff path
/usage-guard off | on                         this session only
/usage-guard simulate 5h 96 [reset-in 2m]     fake a reading in this session (5h|7d, 0-100, s|m|h|d)
/usage-guard simulate off                     back to real readings
```

`simulate` is the way to try it without burning quota: `simulate 5h 91` shows WARN, `simulate 5h 96 reset-in 2m` shows HARD and then the reset two minutes later.

## Settings

In `/plugin` (or `pluginConfigs.usage-guard` in settings):

| Field | Default |
| --- | --- |
| `warn5h`, `warn7d` | 90, 90 |
| `hard5h`, `hard7d` | 95, 97 |
| `autoResume` | false |

## What it never does

- Never tells Claude to commit, push or touch git state.
- Never edits your `settings.json` or statusline.
- Never auto-approves a permission.
- No network calls, no telemetry.

## Known limits

- **Headless `claude -p` gets no readings.** On 2.1.292 the engine reports `rateLimits` empty in print mode (verified: both `session.measure` and `$.session.usage()`), so the guard stays silent there. Interactive sessions, including their subagents, are covered.
- **ralph** re-feeds itself through a settings Stop hook; the note asks Claude to run `/ralph-loop:cancel-ralph`, the mod cannot cancel it directly.
- The note is advice to the model. HARD denies cap the damage if it keeps going, but plain tool calls are not blocked.
- Per-model weekly limits are not exposed to mods; only `five_hour` and `seven_day` are tracked.

## Develop

```
pnpm install
pnpm validate      # claude plugin validate .
pnpm test          # claude plugin test .
pnpm typecheck     # tsc -p . (needs .claude-plugin/types, laid by the engine on load)
claude --plugin-dir .
```

`hooks/core.ts` holds every band decision as pure functions; `hooks/register.tsx` wires them to engine events; `hooks/text.ts` holds every text the model or you read.
