# Planning prompt: usage-guard

Paste everything below the line into a fresh Claude Code session started in this folder.

---

We are planning a Claude Code plugin called `usage-guard`, built as a function-hook mod (hooks.json with `modules`, TypeScript, Claude Code >= 2.1.287). This session is for planning only: grill me on open decisions, then write `PLAN.md`. No code yet.

## Problem

I run many parallel Claude Code sessions with subagents. They regularly hit the 5-hour or 7-day subscription limit mid-task. What is lost: in-flight subagent results, autonomous loops (`/loop`, ralph) that just stop, and context about what was next. Transcripts and file edits survive, and `claude --resume <id>` restores the session, so the goal is a clean wind-down plus a handoff, not saving files.

## Goal

When usage nears a limit, every agent (main session and subagents) learns about it, finishes the current step, writes a handoff, tells me how to resume, and stops. After the reset, work continues from the handoff. Must be shareable with colleagues via `claude plugin marketplace add` + `claude plugin install`.

## Draft spec (challenge it)

1. Signal: `$.session.usage()` (returns `rateLimits[{kind, percentUsed, resetsAt}]`), polled on a timer (~30 s) and on `tool.call`. No statusline dependency, so it should also work headless. Verify this claim.
2. Thresholds in `userConfig` (editable in `/plugin`): WARN 5h 85 / 7d 90, HARD 5h 95 / 7d 97. Escalate one band if current burn rate empties the window before reset.
3. WARN, once per band entry: `$.session.append` a note telling Claude to finish the current step, start nothing new, write a handoff to `~/.claude/handoffs/<project>-<session-id>.md`, tell me `claude --resume <session-id>` and the reset time, end the turn. Never git commit. Band above the prompt with % and countdown.
4. HARD: `tool.call` denies `Agent` and `Workflow` with a reason, plus a toast.
5. Subagents: on `agent.spawn`, append a contract to the prompt ("return results compactly; on a usage warning, stop and return what you have"). Open question: can a mod inject into an already running subagent? `tool.call` events carry `e.agentId` for subagent calls.
6. After reset: one note "limit restored, resume from handoff", dedupe state cleared. Downgrade debounced.
7. `/usage-guard` command: status, `on`, `off`.
8. Stale or missing usage data means silence, never false alarms.

## Hard constraints

- Never instruct Claude to commit, push, or change git state.
- Never modify the user's `settings.json` or statusline.
- Never auto-approve permissions.
- Warn once per band, not on every tool call.
- No network calls, no telemetry.
- TypeScript uses `type`, not `interface`. Use pnpm.

## Reference material

- `research/prior-art.md`: source-level evaluation of heavy-usage and Governer, what to borrow and what to avoid.
- Mods API reference: https://code.claude.com/docs/en/plugins/mods/reference.md (and the `plugin-authoring` skill).
- Working mods to read for API usage, installed locally under `~/.claude/plugins/cache/`:
  - `cc-pr-tracker/cc-pr-tracker/0.3.0`: `$.session.append`, `$.clock.every`, `userConfig`, `$.store`, toast.
  - `hoobnn-agent-mods/todo-bar/0.3.0`: `agent.spawn`, `tool.call` with `e.agentId`, `$.agent.list`, band UI, `$.command.register`.
  - `claude-code-mods/blast-radius/0.2.2`: holding or denying a `tool.call`.

## What I want from this session

1. Read the reference material above. Verify against the docs which spec items are feasible, especially items 1, 3 and 5.
2. Grill me on open decisions one at a time, with your recommendation first: thresholds, handoff location (global `~/.claude/handoffs` vs project `.usage-guard/`), whether HARD should also deny other tools, per-model limits, how to test without actually burning the limit.
3. Write `PLAN.md` as tracer-bullet phases, each with a verify step. Include a test strategy that fakes `$.session.usage()`.
4. Propose the repo layout for a single-plugin marketplace repo.
