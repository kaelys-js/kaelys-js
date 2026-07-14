# Catalog sync — one-time GitHub App setup

`sync-catalog.yml` regenerates the `<!-- catalog:begin -->` block in
`README.md` by fetching `.github/kaelys-catalog.json` from each cataloged
repo. The workflow authenticates via a **GitHub App installation token**
minted per run by
[`actions/create-github-app-token`](https://github.com/actions/create-github-app-token).

Each of the three target repos (`stardust`, `foundation-registry`,
`claude-multiacct`) also ships `.github/workflows/catalog-notify.yml`, which
mints the same App's token and sends a `repository_dispatch` back here when
its catalog file changes. That's why the App is installed on all four repos,
and why the two secrets exist in all four repositories' secret stores.

No long-lived PAT lives in any repo's secrets; the workflows can only act
inside a short-lived token's scope, and there is nothing to rotate.

## Why a GitHub App (and not a PAT)

- **Short-lived token.** The App-installation token is minted per workflow
  run and expires in ~1 hour. A leaked PAT would live for whatever its expiry
  is; a leaked App token is dead within the hour.
- **No rotation.** A PAT expires and needs replacing; the App's private key
  is effectively permanent (revoke any time by regenerating).
- **Scoped by installation.** The App is installed only on the four repos
  it needs, so its token is scoped to those four — no need to remember to
  narrow it.

## Step 1 — Create the GitHub App

Open <https://github.com/settings/apps/new> (personal account) and fill in:

- **GitHub App name:** `kaelys-js-catalog` (name must be globally unique on
  GitHub; if taken, add a suffix — the workflows don't care about the name).
- **Homepage URL:** `https://github.com/kaelys-js/kaelys-js`
- **Webhook — Active:** uncheck (we poll on cron + push repository_dispatch;
  no webhook needed).
- **Repository permissions:**
  - **Contents:** Read and write. Needed here so the sync workflow can push
    the regenerated README back to `kaelys-js/kaelys-js`, AND so each target
    repo's `catalog-notify.yml` can POST `repositories/kaelys-js/kaelys-js/dispatches`
    (that endpoint requires `contents:write` on the target).
  - **Metadata:** Read (mandatory; cannot uncheck).
  - **Statuses:** Read (allows the workflow to poll GitHub-Actions status
    checks if a future auto-merge policy needs it — cheap to grant now).
- **Organization permissions:** none.
- **Where can this GitHub App be installed:** _Only on this account_.

Click **Create GitHub App**.

## Step 2 — Generate a private key

On the App's settings page, scroll to **Private keys** → click **Generate a
private key**. A `.pem` file downloads. Keep it — the same key cannot be
re-downloaded later, only regenerated.

## Step 3 — Install the App on all four repos

Left nav → **Install App** → click **Install** next to the `kaelys-js`
account. Choose **Only select repositories** → tick:

- `kaelys-js/kaelys-js`
- `kaelys-js/stardust`
- `kaelys-js/foundation-registry`
- `kaelys-js/claude-multiacct`

Then click **Install**.

## Step 4 — Note the Client ID

Back on the App settings page (**General** tab), copy the **Client ID** — a
string starting with `Iv23…` shown a few lines below the App name.
`actions/create-github-app-token@v3` deprecated `app-id:` in favour of
`client-id:`, so this is what we need.

## Step 5 — Set the two secrets in all four repos

From a shell where `gh` is authenticated as the repo owner (replace
`<the-client-id>` and the `.pem` path with your values):

```sh
CID="<the-client-id>"
PEM=~/Downloads/<the-downloaded-key>.pem

for repo in kaelys-js/kaelys-js kaelys-js/stardust kaelys-js/foundation-registry kaelys-js/claude-multiacct; do
  gh secret set KAELYS_CATALOG_APP_CLIENT_ID --repo "$repo" --body "$CID"
  gh secret set KAELYS_CATALOG_APP_PRIVATE_KEY --repo "$repo" < "$PEM"
done
```

The `.pem` goes into `KAELYS_CATALOG_APP_PRIVATE_KEY` via stdin — `gh` reads
the file's bytes verbatim (leading `-----BEGIN…` and all).

## Step 6 — Verify with a manual run

The bundled helper detects the two secrets on this repo and, if both are
present, kicks off a `sync-catalog.yml` run and tails it for you:

```sh
./scripts/setup-catalog-app.sh
```

Or by hand:

```sh
gh workflow run sync-catalog.yml --repo kaelys-js/kaelys-js

sleep 5
LATEST=$(gh run list --repo kaelys-js/kaelys-js --workflow sync-catalog.yml \
  --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch --repo kaelys-js/kaelys-js "$LATEST"
```

## Step 7 — What to expect on a healthy first run

`sync-catalog.yml` will:

1. Pass the pre-flight secret check.
2. Mint a fresh App installation token scoped to the four repos.
3. Fetch each target's `.github/kaelys-catalog.json`, validate against
   `schema/kaelys-catalog.schema.json`, and render the marker block.
4. Read `README.md`, replace the marker block if content changed, and push
   the commit under the App bot's identity. If no content changed, the job
   logs `README unchanged — nothing to commit` and exits 0.

The first run WILL produce a commit (the marker block starts as an empty
placeholder). Subsequent runs are idempotent — 0 commits on unchanged
upstream state.

## Troubleshooting

**"Catalog sync is not configured yet."** The pre-flight step in
`sync-catalog.yml` couldn't find one of `KAELYS_CATALOG_APP_CLIENT_ID` /
`KAELYS_CATALOG_APP_PRIVATE_KEY`. Re-run Step 5 for whichever the message
says is missing.

**"Bad credentials" from `create-github-app-token`.** The private key
doesn't match the Client ID — likely regenerated the key without re-setting
the secret. Regenerate the key (App settings → Private keys → Generate a
private key), then re-run Step 5 with the new `.pem`.

**"Resource not accessible by integration" from the workflow.** Either the
App is not installed on one of the four repos, or one of the repository
permissions listed in Step 1 is missing. Check the installation page and
accept any pending permission update.

**A target-repo `catalog-notify.yml` runs but the sync-catalog workflow
never re-triggers.** The dispatch POST needs `contents:write` on the
TARGET (kaelys-js/kaelys-js), not on the SOURCE repo. Confirm the App
installation on kaelys-js/kaelys-js has Contents: Read AND Write — Read
alone silently fails to dispatch.
