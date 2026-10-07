# Prior art (evaluated 2026-10-07)

Both read from source, neither installed. Verdict: neither fits as-is, build our own mod.

## heavy-usage v1.3.1 (github.com/heavyc-dev/heavy-usage)

- Classic command hooks in plugin.json, no function-hook modules. Node, no deps.
- Signal: statusLine wrapper caches `rate_limits` to `~/.claude/heavy-usage/usage-live.json`. Headless `claude -p` never updates it.
- Thresholds (configurable): 5h warn 75 / wind-down 90, 7d warn 85 / wind-down 95.
- Fires only on UserPromptSubmit, so silent during autonomous work and inside subagents.
- Wind-down text tells Claude to "commit what is done". No dedupe, no blocking.
- `/usage setup` rewrites `~/.claude/settings.json` statusLine with a hard-coded absolute path, shadows built-in `/usage`.

## Governer v0.2.0 (github.com/prathameshkadam130404/claude-governor)

- Classic command hooks + statusline wrapper. Events: UserPromptSubmit, PostToolBatch, PostToolUse, PreToolUse, SubagentStop, PreCompact, SessionStart, SessionEnd, StopFailure.
- Bands = max(context, 5h, 7d): ECONOMY / WIND-DOWN / CHECKPOINT. Defaults ctx 70/90/97, 5h 70/90/97, 7d 95/98/99 (7d not configurable via userConfig).
- Burn-rate projection escalates one band if the window runs dry before reset (45/15/5 min). Downgrade debounced 180 s. Stale quota (>10 min) forced to silence.
- CHECKPOINT text: write `.governor/RESUME.md`, git commit, tell user reset time, end turn. Auto-commit conflicts with our rules.
- Repeats WIND-DOWN/CHECKPOINT on every prompt and tool batch (token noise).
- Default mode auto-approves every Agent spawn via PreToolUse `allow`.
- Subagents: contract appended to spawn prompt; live in-subagent hooks marked "untested" by author. SubagentStop tees subagent output to `.governor/subagents/`.
- StopFailure on rate_limit writes machine `RESUME.auto.md` from a tool-call journal; SessionStart injects RESUME (<=7 days, 6000 chars).
- Replaces the statusline without chaining. 1 contributor, 0 stars, last push 2026-07-11.

Ideas worth taking: burn-rate escalation, downgrade debounce, stale data means silence, durable-output contract on spawn, StopFailure-triggered auto-resume note, SessionStart re-injection of handoff.
