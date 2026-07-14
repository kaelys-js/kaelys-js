#!/usr/bin/env node
// sync-catalog.mjs — regenerate the <!-- catalog:begin --> block in README.md
// from every cataloged repo's .github/kaelys-catalog.json.
//
// Flow:
//   1. Load catalog.repos.json (list of {owner, repos}).
//   2. For each repo, GET .github/kaelys-catalog.json via the GitHub API,
//      fall back to reading it off disk when --from-fixtures is set (tests).
//   3. Validate every entry against schema/kaelys-catalog.schema.json (ajv).
//   4. Fetch each repo's GitHub metadata (description, topics, primaryLanguage,
//      visibility, license) as fallback defaults for optional fields.
//   5. Merge catalog + metadata → render the marker block as deterministic
//      Markdown.
//   6. Read README.md, replace the block between the markers, write back only
//      if the on-disk content actually changed.
//
// Determinism guarantees (verified by tests):
//   - Same inputs → same output bytes. No timestamps, no wall-clock reads.
//   - Repos rendered in the order they appear in catalog.repos.json.
//   - Products inside a repo rendered in the order they appear in the catalog
//     file.
//   - Running twice on unchanged inputs is a no-op (0 rewrites).
//
// Auth: GITHUB_TOKEN env var. In CI it's the GitHub App installation token
// minted by actions/create-github-app-token@v3. Locally you can export a fine-
// grained PAT scoped to Contents: Read on the four repos.
//
// Flags:
//   --check                Exit non-zero if README would change (no write).
//   --from-fixtures=DIR    Read catalogs + metadata from local fixtures under
//                          DIR instead of hitting the GitHub API (used by
//                          tests/*.test.mjs).
//   --schema-check-only    Just validate every locally-committed catalog file
//                          (this repo's tests/fixtures/*-catalog.json AND any
//                          real .github/kaelys-catalog.json in a --repos-root
//                          checkout) against the schema. No network, no writes.
//   --repos-root=DIR       Root under which sibling checkouts live. Used only
//                          with --schema-check-only. Defaults to the parent
//                          directory of this repo.
//   --repos-config=PATH    Override catalog.repos.json (tests use this).
//   --readme=PATH          Override README.md (tests use this).
//   --schema=PATH          Override schema/kaelys-catalog.schema.json (tests).

import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SCHEMA_PATH = join(REPO_ROOT, "schema", "kaelys-catalog.schema.json");
const DEFAULT_REPOS_PATH = join(REPO_ROOT, "catalog.repos.json");
const DEFAULT_README_PATH = join(REPO_ROOT, "README.md");

const BEGIN_MARKER = "<!-- catalog:begin -->";
const END_MARKER = "<!-- catalog:end -->";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const args = {
		check: false,
		fromFixtures: null,
		schemaCheckOnly: false,
		reposRoot: null,
		reposConfig: DEFAULT_REPOS_PATH,
		readme: DEFAULT_README_PATH,
		schema: DEFAULT_SCHEMA_PATH,
	};
	for (const arg of argv.slice(2)) {
		if (arg === "--check") args.check = true;
		else if (arg === "--schema-check-only") args.schemaCheckOnly = true;
		else if (arg.startsWith("--from-fixtures=")) args.fromFixtures = arg.slice("--from-fixtures=".length);
		else if (arg.startsWith("--repos-root=")) args.reposRoot = arg.slice("--repos-root=".length);
		else if (arg.startsWith("--repos-config=")) args.reposConfig = arg.slice("--repos-config=".length);
		else if (arg.startsWith("--readme=")) args.readme = arg.slice("--readme=".length);
		else if (arg.startsWith("--schema=")) args.schema = arg.slice("--schema=".length);
		else if (arg === "--help" || arg === "-h") {
			process.stdout.write(help());
			process.exit(0);
		} else {
			process.stderr.write(`sync-catalog: unknown flag ${arg}\n${help()}`);
			process.exit(2);
		}
	}
	return args;
}

function help() {
	return `Usage: node scripts/sync-catalog.mjs [--check] [--from-fixtures=DIR] [--schema-check-only] [--repos-root=DIR]

  --check                Exit non-zero if README would change; do not write.
  --from-fixtures=DIR    Read catalogs + metadata from DIR/<repo>-catalog.json
                         + DIR/<repo>-metadata.json instead of GitHub. Used by
                         tests.
  --schema-check-only    Validate every catalog file (this repo's fixtures +
                         any sibling repo checkouts) against the schema. No
                         network. Doesn't touch README.
  --repos-root=DIR       Sibling checkouts root for --schema-check-only.
                         Defaults to the parent directory of this repo.
`;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

async function loadValidator(schemaPath) {
	const schema = JSON.parse(await readFile(schemaPath, "utf8"));
	const ajv = new Ajv({ allErrors: true, strict: true });
	addFormats(ajv);
	const validate = ajv.compile(schema);
	return function assertValid(name, doc) {
		if (!validate(doc)) {
			const errs = validate.errors
				.map((e) => `  ${e.instancePath || "/"} ${e.message}`)
				.join("\n");
			throw new Error(`kaelys-catalog.json for "${name}" is invalid:\n${errs}`);
		}
	};
}

// ---------------------------------------------------------------------------
// GitHub / fixture loaders
// ---------------------------------------------------------------------------

async function githubFetch(url, token) {
	const res = await fetch(url, {
		headers: {
			"user-agent": "kaelys-js-sync-catalog",
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`GitHub ${res.status} on ${url}: ${body.slice(0, 300)}`);
	}
	return res.json();
}

async function fetchCatalogFromGitHub(owner, name, token) {
	const url = `https://api.github.com/repos/${owner}/${name}/contents/.github/kaelys-catalog.json`;
	const body = await githubFetch(url, token);
	if (body.encoding !== "base64" || typeof body.content !== "string") {
		throw new Error(`Unexpected /contents response shape for ${owner}/${name}`);
	}
	return JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
}

async function fetchMetadataFromGitHub(owner, name, token) {
	const repo = await githubFetch(`https://api.github.com/repos/${owner}/${name}`, token);
	return {
		description: repo.description || null,
		topics: Array.isArray(repo.topics) ? [...repo.topics].sort() : [],
		primaryLanguage: repo.language || null,
		visibility: repo.visibility || (repo.private ? "private" : "public"),
		license: repo.license && repo.license.spdx_id !== "NOASSERTION" ? repo.license.spdx_id : null,
		htmlUrl: repo.html_url,
	};
}

async function loadFromFixtures(dir, owner, name) {
	const catalog = JSON.parse(await readFile(join(dir, `${name}-catalog.json`), "utf8"));
	const metadata = JSON.parse(await readFile(join(dir, `${name}-metadata.json`), "utf8"));
	return { catalog, metadata };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_BADGE = {
	stable: "stable",
	beta: "beta",
	alpha: "alpha",
	wip: "wip",
	archived: "archived",
};

/**
 * Render the marker block. Output is DETERMINISTIC:
 *   - repos in the order supplied
 *   - fields in a fixed order per repo
 *   - no timestamps
 */
function renderBlock(owner, entries) {
	const lines = [];
	lines.push(BEGIN_MARKER);
	lines.push("");
	lines.push("<!-- Regenerated by scripts/sync-catalog.mjs; do not hand-edit inside these markers. -->");
	lines.push("");
	for (const { catalog, metadata } of entries) {
		lines.push(...renderRepoCard(owner, catalog, metadata));
		lines.push("");
	}
	lines.push(END_MARKER);
	return lines.join("\n");
}

function renderRepoCard(owner, catalog, metadata) {
	const name = catalog.name;
	const url = metadata.htmlUrl || `https://github.com/${owner}/${name}`;
	const status = STATUS_BADGE[catalog.status] || catalog.status;
	const primaryLanguage = catalog.primaryLanguage || metadata.primaryLanguage || null;
	const topics = (catalog.topics && catalog.topics.length > 0)
		? catalog.topics
		: metadata.topics;
	const lines = [];

	lines.push(`### [${name}](${url})  \`${status}\``);
	lines.push("");
	lines.push(`_${escapeInline(catalog.tagline)}_`);
	lines.push("");
	lines.push(escapeInline(catalog.sellMe));
	lines.push("");

	const factRows = [];
	if (catalog.since) factRows.push(["Since", String(catalog.since)]);
	if (primaryLanguage) factRows.push(["Language", primaryLanguage]);
	if (metadata.visibility) factRows.push(["Visibility", metadata.visibility]);
	if (metadata.license) factRows.push(["License", metadata.license]);
	if (catalog.technology && catalog.technology.length > 0) {
		factRows.push(["Stack", catalog.technology.join(", ")]);
	}
	if (topics && topics.length > 0) {
		factRows.push(["Topics", topics.map((t) => `\`${t}\``).join(" ")]);
	}
	if (factRows.length > 0) {
		lines.push("| | |");
		lines.push("|---|---|");
		for (const [k, v] of factRows) lines.push(`| ${k} | ${v} |`);
		lines.push("");
	}

	if (catalog.products && catalog.products.length > 0) {
		lines.push("**Products**");
		lines.push("");
		for (const p of catalog.products) {
			lines.push(`- \`${p.name}\` — ${escapeInline(p.description)}`);
		}
		lines.push("");
	}

	if (catalog.links && Object.keys(catalog.links).length > 0) {
		const linkOrder = ["homepage", "docs", "releases", "issues", "discussions"];
		const parts = [];
		for (const key of linkOrder) {
			if (catalog.links[key]) parts.push(`[${key}](${catalog.links[key]})`);
		}
		if (parts.length > 0) {
			lines.push(parts.join(" · "));
			lines.push("");
		}
	}

	// Strip trailing blank lines so the joiner produces uniform spacing.
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Prevent stray Markdown tokens in prose from breaking the render. */
function escapeInline(s) {
	// Only strip control characters + normalise CRLF → LF. We deliberately
	// preserve markdown-meaningful punctuation (backticks, brackets, *) because
	// authors legitimately want emphasis in taglines/sellMe.
	return String(s).replace(/\r\n?/g, "\n").replace(/[ --]/g, "");
}

// ---------------------------------------------------------------------------
// README rewrite
// ---------------------------------------------------------------------------

function replaceBlock(readme, newBlock) {
	const begin = readme.indexOf(BEGIN_MARKER);
	const end = readme.indexOf(END_MARKER);
	if (begin === -1 || end === -1 || end < begin) {
		throw new Error(
			`README.md is missing "${BEGIN_MARKER}"/"${END_MARKER}" markers; add them exactly once (in that order) inside the section you want the catalog to render into.`,
		);
	}
	const before = readme.slice(0, begin);
	const after = readme.slice(end + END_MARKER.length);
	return `${before}${newBlock}${after}`;
}

// ---------------------------------------------------------------------------
// Schema-check-only walker
// ---------------------------------------------------------------------------

async function runSchemaCheckOnly({ reposRoot, schemaPath, reposConfigPath }) {
	const assertValid = await loadValidator(schemaPath);
	const root = reposRoot || resolve(REPO_ROOT, "..");

	// Fixtures shipped in this repo (always present).
	const fixturesDir = join(REPO_ROOT, "tests", "fixtures");
	let count = 0;
	if (existsSync(fixturesDir)) {
		for (const f of readdirSync(fixturesDir)) {
			if (!f.endsWith("-catalog.json")) continue;
			const path = join(fixturesDir, f);
			const doc = JSON.parse(await readFile(path, "utf8"));
			assertValid(f, doc);
			count++;
		}
	}

	// Sibling checkouts, if any.
	const config = JSON.parse(await readFile(reposConfigPath, "utf8"));
	for (const name of config.repos) {
		const path = join(root, name, ".github", "kaelys-catalog.json");
		if (!existsSync(path)) continue;
		const doc = JSON.parse(await readFile(path, "utf8"));
		assertValid(name, doc);
		count++;
	}

	process.stdout.write(`sync-catalog: schema-check-only OK (${count} file(s))\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const args = parseArgs(process.argv);

	if (args.schemaCheckOnly) {
		await runSchemaCheckOnly({
			reposRoot: args.reposRoot,
			schemaPath: args.schema,
			reposConfigPath: args.reposConfig,
		});
		return;
	}

	const assertValid = await loadValidator(args.schema);
	const config = JSON.parse(await readFile(args.reposConfig, "utf8"));
	const owner = config.owner;
	const token = process.env.GITHUB_TOKEN || "";

	if (!args.fromFixtures && !token) {
		process.stderr.write(
			"sync-catalog: GITHUB_TOKEN env var is not set. In CI this is minted by actions/create-github-app-token@v3; locally, export a fine-grained PAT scoped to Contents:Read on kaelys-js/{stardust,foundation-registry,claude-multiacct}.\n",
		);
		process.exit(1);
	}

	const entries = [];
	for (const name of config.repos) {
		let catalog;
		let metadata;
		if (args.fromFixtures) {
			({ catalog, metadata } = await loadFromFixtures(args.fromFixtures, owner, name));
		} else {
			catalog = await fetchCatalogFromGitHub(owner, name, token);
			metadata = await fetchMetadataFromGitHub(owner, name, token);
		}
		assertValid(name, catalog);
		if (catalog.name !== name) {
			throw new Error(
				`Repo ${owner}/${name} publishes a catalog with name="${catalog.name}"; the "name" field must match the repo slug.`,
			);
		}
		entries.push({ catalog, metadata });
	}

	const block = renderBlock(owner, entries);
	const oldReadme = await readFile(args.readme, "utf8");
	const newReadme = replaceBlock(oldReadme, block);

	if (newReadme === oldReadme) {
		process.stdout.write("sync-catalog: README already up to date — no changes.\n");
		return;
	}

	if (args.check) {
		process.stderr.write("sync-catalog: README would change (--check mode; refusing to write).\n");
		process.exit(1);
	}

	await writeFile(args.readme, newReadme);
	process.stdout.write(`sync-catalog: rewrote README.md (${entries.length} repo(s)).\n`);
}

main().catch((err) => {
	process.stderr.write(`sync-catalog: ${err.message}\n`);
	if (process.env.DEBUG) process.stderr.write(`${err.stack}\n`);
	process.exit(1);
});
