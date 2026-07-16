# Contributing to kaelys-js

Thanks for considering a contribution. This repo hosts the `kaelys-js`
GitHub org profile README and the machinery that regenerates its
`<!-- catalog:begin -->` block from sibling repos.

## Engineering rules

Every code change follows the 13 rules in [AGENTS.md](AGENTS.md). Rule 13
is the load-bearing one: approved work ships fully, no scope narrowed
silently.

## Pull request flow

- Open a PR against `main`. Fill out the template (Summary / Test plan /
  Rule 13 checkboxes).
- Match the [`kaelys-catalog`](https://github.com/kaelys-js/kaelys-js#kaelys-catalog-schema)
  schema if you touch `.github/kaelys-catalog.json` or the
  `scripts/sync-catalog.mjs` generator — the CI `schema` check fails
  otherwise.
- CI runs `lint + schema + test` on every PR. The gate is required for
  merge; fix in-branch rather than opening follow-on PRs.

## Local gates before you push

```sh
pnpm qa:lint
pnpm qa:format:check
```

## Reporting security issues

Do NOT open a public issue for anything security-adjacent — see
[SECURITY.md](SECURITY.md) for the private-vulnerability-reporting path.
