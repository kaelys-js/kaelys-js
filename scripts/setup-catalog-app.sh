#!/usr/bin/env bash
#
# setup-catalog-app.sh — verify the sync-catalog GitHub App secrets exist on
# kaelys-js/kaelys-js and, if so, trigger a manual sync-catalog.yml run + tail
# it.
#
# See docs/catalog-setup.md for the one-time browser setup this script depends
# on. This script does NOT ask for or handle secret VALUES — it only checks
# whether the two secrets are present and, if they are, smoke-tests the
# workflow. If either secret is missing, it prints the runbook inline and
# exits non-zero.
set -euo pipefail

REPO="kaelys-js/kaelys-js"
WORKFLOW="sync-catalog.yml"
DOC_PATH="docs/catalog-setup.md"

command -v gh > /dev/null || {
  echo "setup-catalog-app: gh CLI not found on PATH" >&2
  exit 1
}
gh auth status > /dev/null 2>&1 || {
  echo "setup-catalog-app: gh is not authenticated — run 'gh auth login'" >&2
  exit 1
}

secrets="$(gh api "repos/${REPO}/actions/secrets" --jq '.secrets[].name')"
have_cid=0
have_pk=0
if grep -qx KAELYS_CATALOG_APP_CLIENT_ID <<< "${secrets}"; then have_cid=1; fi
if grep -qx KAELYS_CATALOG_APP_PRIVATE_KEY <<< "${secrets}"; then have_pk=1; fi

if [ "${have_cid}" -eq 1 ] && [ "${have_pk}" -eq 1 ]; then
  echo "setup-catalog-app: catalog secrets already configured on ${REPO}."
  echo "setup-catalog-app: triggering a manual run of ${WORKFLOW}..."
  gh workflow run "${WORKFLOW}" --repo "${REPO}"
  sleep 5
  latest="$(gh run list --repo "${REPO}" --workflow "${WORKFLOW}" \
    --limit 1 --json databaseId --jq '.[0].databaseId')"
  echo "setup-catalog-app: tailing run ${latest}..."
  exec gh run watch --repo "${REPO}" "${latest}"
fi

echo "setup-catalog-app: catalog sync is not yet configured on ${REPO}."
echo
echo "  Missing secret(s):"
[ "${have_cid}" -eq 0 ] && echo "    - KAELYS_CATALOG_APP_CLIENT_ID"
[ "${have_pk}" -eq 0 ] && echo "    - KAELYS_CATALOG_APP_PRIVATE_KEY"
echo
echo "  Runbook (${DOC_PATH}):"
echo "  ─────────────────────────────────────────────────────────────"
if [ -f "${DOC_PATH}" ]; then
  cat "${DOC_PATH}"
else
  echo "  (missing ${DOC_PATH} — see the repo tree)" >&2
fi
echo "  ─────────────────────────────────────────────────────────────"
exit 1
