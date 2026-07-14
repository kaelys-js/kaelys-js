// tests/sync-catalog.test.mjs — hermetic tests for scripts/sync-catalog.mjs.
//
// Runs under `node --test`. No network — we use --from-fixtures to feed the
// script hand-written catalog + metadata JSON, then assert:
//   1. The render matches a checked-in expected Markdown fragment. This is the
//      determinism guarantee — a change in the renderer must update the
//      expected file, forcing a human review.
//   2. Running the script twice on unchanged inputs is a no-op (0 rewrites).
//      This is the idempotency guarantee — repository_dispatch retriggers on
//      unchanged upstream files cannot flap the profile README.
//   3. Schema validation actually rejects an invalid catalog. Tests a broken
//      fixture inline so a future loosening of the schema is caught here, not
//      in production.
//   4. --schema-check-only walks tests/fixtures/*-catalog.json and passes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "sync-catalog.mjs");
const SCHEMA = join(REPO_ROOT, "schema", "kaelys-catalog.schema.json");
const FIXTURES = join(HERE, "fixtures");
const EXPECTED = join(HERE, "expected", "readme.md");
const REPOS_CONFIG = join(FIXTURES, "repos.json");

const README_TEMPLATE = `# Test profile

Hand-authored prose that must survive every sync.

## Projects

<!-- catalog:begin -->
STALE PLACEHOLDER — SHOULD BE REPLACED
<!-- catalog:end -->

## Footer

More hand-authored prose that must survive every sync.
`;

function runSync(args, cwd = REPO_ROOT) {
	return spawnSync(process.execPath, [SCRIPT, ...args], {
		cwd,
		env: { ...process.env, GITHUB_TOKEN: "" },
		encoding: "utf8",
	});
}

function makeScratch() {
	const dir = mkdtempSync(join(tmpdir(), "sync-catalog-"));
	const readmePath = join(dir, "README.md");
	writeFileSync(readmePath, README_TEMPLATE);
	return { dir, readmePath };
}

test("render matches the checked-in expected fixture (deterministic)", () => {
	const { readmePath } = makeScratch();
	const result = runSync([
		`--from-fixtures=${FIXTURES}`,
		`--repos-config=${REPOS_CONFIG}`,
		`--schema=${SCHEMA}`,
		`--readme=${readmePath}`,
	]);
	assert.equal(
		result.status,
		0,
		`sync failed with status ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
	);
	const rendered = readFileSync(readmePath, "utf8");
	const expected = readFileSync(EXPECTED, "utf8");
	assert.equal(
		rendered,
		expected,
		`Rendered README does not match tests/expected/readme.md. If the renderer intentionally changed, update the expected fixture; otherwise this is a determinism regression.`,
	);
});

test("second run on unchanged inputs is a no-op (idempotent)", () => {
	const { readmePath } = makeScratch();
	const first = runSync([
		`--from-fixtures=${FIXTURES}`,
		`--repos-config=${REPOS_CONFIG}`,
		`--schema=${SCHEMA}`,
		`--readme=${readmePath}`,
	]);
	assert.equal(first.status, 0, `first sync failed: ${first.stderr}`);
	const afterFirst = readFileSync(readmePath, "utf8");

	const second = runSync([
		`--from-fixtures=${FIXTURES}`,
		`--repos-config=${REPOS_CONFIG}`,
		`--schema=${SCHEMA}`,
		`--readme=${readmePath}`,
	]);
	assert.equal(second.status, 0, `second sync failed: ${second.stderr}`);
	assert.match(
		second.stdout,
		/already up to date/,
		"second sync should log 'already up to date' when the render is unchanged",
	);
	const afterSecond = readFileSync(readmePath, "utf8");
	assert.equal(afterFirst, afterSecond, "second run modified README despite unchanged inputs");
});

test("--check exits non-zero when README would change", () => {
	const { readmePath } = makeScratch();
	const result = runSync([
		`--from-fixtures=${FIXTURES}`,
		`--repos-config=${REPOS_CONFIG}`,
		`--schema=${SCHEMA}`,
		`--readme=${readmePath}`,
		"--check",
	]);
	assert.notEqual(result.status, 0, "--check with drift should exit non-zero");
	assert.match(result.stderr, /would change/);
	// README stayed untouched.
	assert.equal(readFileSync(readmePath, "utf8"), README_TEMPLATE);
});

test("schema validation rejects a broken catalog", () => {
	// Build a scratch fixtures dir with one repo whose catalog is missing
	// required fields. The script must abort BEFORE touching the README.
	const scratch = mkdtempSync(join(tmpdir(), "sync-catalog-bad-"));
	mkdirSync(join(scratch, "fixtures"), { recursive: true });
	writeFileSync(
		join(scratch, "fixtures", "broken-catalog.json"),
		JSON.stringify({ name: "broken" }, null, "\t"),
	);
	writeFileSync(
		join(scratch, "fixtures", "broken-metadata.json"),
		JSON.stringify(
			{
				description: null,
				topics: [],
				primaryLanguage: null,
				visibility: "public",
				license: null,
				htmlUrl: "https://github.com/kaelys-js/broken",
			},
			null,
			"\t",
		),
	);
	writeFileSync(
		join(scratch, "repos.json"),
		JSON.stringify({ owner: "kaelys-js", repos: ["broken"] }, null, "\t"),
	);
	const readmePath = join(scratch, "README.md");
	writeFileSync(readmePath, README_TEMPLATE);

	const result = runSync([
		`--from-fixtures=${join(scratch, "fixtures")}`,
		`--repos-config=${join(scratch, "repos.json")}`,
		`--schema=${SCHEMA}`,
		`--readme=${readmePath}`,
	]);
	assert.notEqual(result.status, 0, "sync must fail on schema-invalid catalog");
	assert.match(result.stderr, /invalid/i);
	// README stayed untouched.
	assert.equal(
		readFileSync(readmePath, "utf8"),
		README_TEMPLATE,
		"a schema failure must not have rewritten the README",
	);
});

test("--schema-check-only validates every fixture catalog", () => {
	const result = runSync([
		"--schema-check-only",
		`--schema=${SCHEMA}`,
		`--repos-config=${REPOS_CONFIG}`,
		`--repos-root=${join(HERE, "no-such-dir")}`,
	]);
	assert.equal(
		result.status,
		0,
		`schema-check-only failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
	);
	assert.match(result.stdout, /schema-check-only OK/);
});

test("catalog name must match repo slug", () => {
	// alpha-catalog.json says name="alpha"; register it under "wrong" and the
	// script must abort with a name-mismatch error.
	const scratch = mkdtempSync(join(tmpdir(), "sync-catalog-mismatch-"));
	mkdirSync(join(scratch, "fixtures"), { recursive: true });
	cpSync(join(FIXTURES, "alpha-catalog.json"), join(scratch, "fixtures", "wrong-catalog.json"));
	cpSync(join(FIXTURES, "alpha-metadata.json"), join(scratch, "fixtures", "wrong-metadata.json"));
	writeFileSync(
		join(scratch, "repos.json"),
		JSON.stringify({ owner: "kaelys-js", repos: ["wrong"] }, null, "\t"),
	);
	const readmePath = join(scratch, "README.md");
	writeFileSync(readmePath, README_TEMPLATE);

	const result = runSync([
		`--from-fixtures=${join(scratch, "fixtures")}`,
		`--repos-config=${join(scratch, "repos.json")}`,
		`--schema=${SCHEMA}`,
		`--readme=${readmePath}`,
	]);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /name field must match|slug/i);
	// README untouched.
	assert.equal(readFileSync(readmePath, "utf8"), README_TEMPLATE);
});

test("required-only catalog renders no empty <dl> or blank rows", () => {
	// Catalog with ONLY the schema-required fields (name/tagline/sellMe/
	// status) + metadata reporting zero facts (no license, no topics, no
	// primaryLanguage). The <dl> block must be omitted entirely — an
	// empty <dl> or blank <dt></dt><dd></dd> pair would surface as a
	// visible artifact on the profile README.
	const scratch = mkdtempSync(join(tmpdir(), "sync-catalog-minreq-"));
	mkdirSync(join(scratch, "fixtures"), { recursive: true });
	writeFileSync(
		join(scratch, "fixtures", "minreq-catalog.json"),
		JSON.stringify(
			{
				name: "minreq",
				tagline: "Minimum required — proves no blank rows leak through.",
				sellMe: "This catalog has only the schema-required fields. No products, no license, no topics, no visibility fallback.",
				status: "alpha",
			},
			null,
			"\t",
		),
	);
	writeFileSync(
		join(scratch, "fixtures", "minreq-metadata.json"),
		JSON.stringify(
			{
				description: null,
				topics: [],
				primaryLanguage: null,
				visibility: null,
				license: null,
				htmlUrl: "https://github.com/kaelys-js/minreq",
			},
			null,
			"\t",
		),
	);
	writeFileSync(
		join(scratch, "repos.json"),
		JSON.stringify({ owner: "kaelys-js", repos: ["minreq"] }, null, "\t"),
	);
	const readmePath = join(scratch, "README.md");
	writeFileSync(readmePath, README_TEMPLATE);

	const result = runSync([
		`--from-fixtures=${join(scratch, "fixtures")}`,
		`--repos-config=${join(scratch, "repos.json")}`,
		`--schema=${SCHEMA}`,
		`--readme=${readmePath}`,
	]);
	assert.equal(result.status, 0, `sync failed: ${result.stderr}`);
	const rendered = readFileSync(readmePath, "utf8");

	// No <dl> block at all — every optional field is unset, so the
	// renderer must skip the facts section entirely instead of emitting
	// an empty <dl></dl>.
	assert.ok(
		!rendered.includes("<dl>"),
		`required-only render must omit the <dl> block; got:\n${rendered}`,
	);
	// And obviously no blank rows.
	assert.ok(!rendered.includes("<dt></dt>"), "no blank <dt></dt>");
	assert.ok(!rendered.includes("<dd></dd>"), "no blank <dd></dd>");
	// The row labels for optional fields must not appear either.
	for (const label of ["Since", "Language", "Visibility", "License", "Stack", "Topics"]) {
		assert.ok(
			!rendered.includes(`<dt>${label}</dt>`),
			`optional field "${label}" leaked into required-only render`,
		);
	}
	// The required prose still lands.
	assert.match(rendered, /Minimum required/);
	assert.match(rendered, /minreq/);
});

test("missing markers surface a clear error", () => {
	const { dir, readmePath } = makeScratch();
	writeFileSync(readmePath, "# No markers here.\n");
	const result = runSync([
		`--from-fixtures=${FIXTURES}`,
		`--repos-config=${REPOS_CONFIG}`,
		`--schema=${SCHEMA}`,
		`--readme=${readmePath}`,
	]);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /missing.*catalog:begin.*catalog:end/i);
	// A .worktrees ref check just to keep `dir` used and detectable in output.
	assert.ok(existsSync(dir));
});
