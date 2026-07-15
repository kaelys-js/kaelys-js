# Security Policy

## Reporting a vulnerability

If you find a security issue in this repo, please report it privately through
GitHub's private vulnerability reporting:

**[Report a vulnerability](https://github.com/kaelys-js/kaelys-js/security/advisories/new)**

Private reports let us investigate and coordinate a fix before the issue is
public. Please avoid opening a public issue for anything that could be exploited.

## Scope

This repo hosts the `kaelys-js` GitHub org profile README and the machinery
that regenerates its `<!-- catalog:begin -->` block from sibling repos. In-scope
issues include:

- Injection paths in `scripts/sync-catalog.mjs` (e.g. content from a target
  repo's `.github/kaelys-catalog.json` being interpolated into README markup or
  a shell command without escaping).
- Escalation from a compromised target-repo catalog file to code execution or
  privileged writes on this repo.
- Leaked or over-scoped `KAELYS_CATALOG_APP_*` secrets — the GitHub App is
  scoped to `Contents: read+write` on four repos; any wider scope is a bug.
- Any workflow that logs or exports a secret to an untrusted sink.

Known limitations:

- Vulnerabilities in the upstream GitHub Actions we pin (report those to the
  action's maintainer).
- Bugs affecting only your own fork or local checkout with no security impact.

## Supported versions

The `main` branch is the only supported version.
