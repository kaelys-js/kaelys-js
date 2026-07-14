# AGENTS.md -- engineering rules + orientation

_Part of the [kaelys-js](README.md) docs._

> **What this file is.** The engineering rules every AI agent follows when doing CODE work in this repo (refactors, feature work, docs, code review). It's deliberately short -- read these first. The rules apply to interactive Claude Code sessions and to any workflow sub-agents spawned from this repo.

## Orientation

**kaelys-js/kaelys-js** is the GitHub org profile-README repo. It renders as the landing page at <https://github.com/kaelys-js>. Two jobs:

1. Hold the hand-authored profile prose (top of `README.md`, everything **outside** the `<!-- catalog:begin --><!-- catalog:end -->` markers).
2. Aggregate a small **catalog** of the org's other repos into the marker block. Each cataloged repo ships a `.github/kaelys-catalog.json` describing itself; `scripts/sync-catalog.mjs` fetches all of them, validates against `schema/kaelys-catalog.schema.json`, and rewrites the marker block on a daily cron + `repository_dispatch: catalog-updated` + `workflow_dispatch`.

- **Layout**: `scripts/` is the sync + setup helpers; `schema/` is the JSON Schema; `tests/` is Node's built-in `node --test` runner over fixtures; `catalog.repos.json` at the root lists the repos to poll; `docs/catalog-setup.md` is the one-time GitHub App runbook.
- **Toolchain (self-contained)**: pinned in this repo's own `mise.toml` (node + pnpm + yq + gitleaks + yamllint + markdownlint-cli2). Clone + `mise install` gets everything.
- **Lint / test**: `pnpm lint` runs oxlint + gitleaks; `pnpm test` runs the `node --test` suite. Both invoke the toolchain via `mise`.
- **No build step**: `scripts/sync-catalog.mjs` runs directly under Node.
- **Idempotency**: the sync script is a pure function of (four catalog files + four repos' GitHub metadata + current README). Running it a second time on unchanged inputs is a no-op — 0 commits.
- **Git hooks / secrets**: `.gitleaks.toml` at the root. Default branch `main`, provider GitHub.

## 13 rules

These apply to every code task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

### Rule 1 -- Think before coding

State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Stop when confused. Name what's unclear.

### Rule 2 -- Simplicity first

Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

### Rule 3 -- Surgical changes

Touch only what you must. Clean up only your own mess.
Don't "improve" adjacent code, comments, or formatting.
Don't refactor what isn't broken. Match existing style.

### Rule 4 -- Goal-driven execution

Define success criteria. Loop until verified.
Don't follow steps. Define success and iterate.
Strong success criteria let you loop independently.

### Rule 5 -- Use the model only for judgment calls

Use me for: classification, drafting, summarization, extraction.
Do NOT use me for: routing, retries, deterministic transforms.
If code can answer, code answers.

### Rule 6 -- Token budgets are not advisory

Inline single-agent work: 4,000 tokens per task, 30,000 per session.
Explicitly-approved multi-agent workflow runs are exempt from these numbers,
never from the duty to surface cost.
If approaching budget, summarize and start fresh.
Surface the breach. Do not silently overrun.

### Rule 7 -- Surface conflicts, don't average them

If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Don't blend conflicting patterns.

### Rule 8 -- Read before you write

Before adding code, read exports, immediate callers, shared utilities.
"Looks orthogonal" is dangerous. If unsure why code is structured a way, ask.

### Rule 9 -- Tests verify intent, not just behaviour

Tests must encode WHY behaviour matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

### Rule 10 -- Checkpoint after every significant step

Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.
If you lose track, stop and restate.

### Rule 11 -- Match the codebase's conventions, even if you disagree

Conformance > taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Don't fork silently.

### Rule 12 -- Fail loud

"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

### Rule 13 -- Approved work ships fully

When you hit friction on approved work -- an API mismatch, an unfamiliar config shape, a missing test fixture, anything -- the response is "investigate the docs/source until you find the right shape and implement it fully". NOT "downgrade scope to a follow-up".

Forbidden vocabulary on approved work:
`MVP`, `defer`, `out of scope`, `won't fit`, `future PR`, `future work`, `separate ticket`, `separate PR`, `follow-up`, `simplify to`, `for now`, `punt`, `leave for now`.

If something genuinely can't be done with current resources, explain the constraint with evidence and ASK for permission before narrowing scope. Don't narrow unilaterally.
