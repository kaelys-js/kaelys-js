// tests/sync-catalog.unit.test.mjs — unit tests importing every function
// directly from scripts/sync-catalog.mjs. Complements the spawn-based
// sync-catalog.test.mjs (which stays as end-to-end coverage) by hitting
// every branch of every helper for coverage-v8 to record.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	parseArgs,
	help,
	loadValidator,
	githubFetch,
	fetchCatalogFromGitHub,
	fetchMetadataFromGitHub,
	loadFromFixtures,
	renderBlock,
	renderRepoCard,
	escapeInline,
	replaceBlock,
	runSchemaCheckOnly,
	main,
	BEGIN_MARKER,
	END_MARKER,
	STATUS_BADGE,
	DEFAULT_SCHEMA_PATH,
	DEFAULT_REPOS_PATH,
	DEFAULT_README_PATH,
	REPO_ROOT,
} from "../scripts/sync-catalog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const SCHEMA = join(HERE, "..", "schema", "kaelys-catalog.schema.json");
const REPOS_CONFIG = join(FIXTURES, "repos.json");

// ─── parseArgs ───────────────────────────────────────────────────────────

describe("parseArgs", () => {
	test("defaults when no flags are supplied", () => {
		const args = parseArgs(["node", "sync-catalog.mjs"]);
		expect(args.check).toBe(false);
		expect(args.fromFixtures).toBe(null);
		expect(args.schemaCheckOnly).toBe(false);
		expect(args.reposRoot).toBe(null);
		expect(args.reposConfig).toBe(DEFAULT_REPOS_PATH);
		expect(args.readme).toBe(DEFAULT_README_PATH);
		expect(args.schema).toBe(DEFAULT_SCHEMA_PATH);
	});

	test("--check flips the check flag", () => {
		expect(parseArgs(["_", "_", "--check"]).check).toBe(true);
	});

	test("--schema-check-only flips schemaCheckOnly", () => {
		expect(parseArgs(["_", "_", "--schema-check-only"]).schemaCheckOnly).toBe(true);
	});

	test("--from-fixtures= captures the directory", () => {
		expect(parseArgs(["_", "_", "--from-fixtures=/tmp/fx"]).fromFixtures).toBe("/tmp/fx");
	});

	test("--repos-root= captures the root", () => {
		expect(parseArgs(["_", "_", "--repos-root=/tmp/rr"]).reposRoot).toBe("/tmp/rr");
	});

	test("--repos-config= captures the path", () => {
		expect(parseArgs(["_", "_", "--repos-config=/tmp/rc.json"]).reposConfig).toBe("/tmp/rc.json");
	});

	test("--readme= captures the path", () => {
		expect(parseArgs(["_", "_", "--readme=/tmp/README.md"]).readme).toBe("/tmp/README.md");
	});

	test("--schema= captures the path", () => {
		expect(parseArgs(["_", "_", "--schema=/tmp/s.json"]).schema).toBe("/tmp/s.json");
	});

	test.each(["--help", "-h"])("%s prints help and exits 0", (flag) => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("__exit__");
		});
		expect(() => parseArgs(["_", "_", flag])).toThrow("__exit__");
		expect(write).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
		expect(exit).toHaveBeenCalledWith(0);
		write.mockRestore();
		exit.mockRestore();
	});

	test("unknown flag prints error to stderr and exits 2", () => {
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("__exit__");
		});
		expect(() => parseArgs(["_", "_", "--nope"])).toThrow("__exit__");
		expect(err).toHaveBeenCalledWith(expect.stringMatching(/unknown flag --nope/));
		expect(exit).toHaveBeenCalledWith(2);
		err.mockRestore();
		exit.mockRestore();
	});
});

// ─── help ────────────────────────────────────────────────────────────────

describe("help", () => {
	test("returns the usage string with every documented flag", () => {
		const s = help();
		expect(s).toMatch(/Usage:/);
		for (const flag of ["--check", "--from-fixtures", "--schema-check-only", "--repos-root"]) {
			expect(s).toContain(flag);
		}
	});
});

// ─── constants ───────────────────────────────────────────────────────────

describe("constants", () => {
	test("markers are stable and distinguishable", () => {
		expect(BEGIN_MARKER).toBe("<!-- catalog:begin -->");
		expect(END_MARKER).toBe("<!-- catalog:end -->");
	});
	test("STATUS_BADGE covers every schema status", () => {
		for (const status of ["stable", "beta", "alpha", "wip", "archived"]) {
			expect(STATUS_BADGE[status]).toBe(status);
		}
	});
	test("REPO_ROOT resolves to a real directory (this repo)", () => {
		expect(REPO_ROOT).toMatch(/kaelys-js$/);
	});
});

// ─── escapeInline ────────────────────────────────────────────────────────

describe("escapeInline", () => {
	test("normalises CRLF to LF", () => {
		expect(escapeInline("hello\r\nworld")).toBe("hello\nworld");
	});
	test("normalises bare CR to LF", () => {
		expect(escapeInline("hello\rworld")).toBe("hello\nworld");
	});
	test("strips ASCII control characters below 0x20 (except tab, LF, CR)", () => {
		// The regex in the source is /[\0-\b\v\f\x0E-\x1F]/g — every control
		// char EXCEPT 0x09 (tab), 0x0A (LF), 0x0D (CR). Confirm each
		// preserved char passes through and each stripped one is removed.
		expect(escapeInline("a\x00b")).toBe("ab"); // NUL stripped
		expect(escapeInline("a\bb")).toBe("ab"); // backspace stripped
		expect(escapeInline("a\vb")).toBe("ab"); // vertical tab stripped
		expect(escapeInline("a\fb")).toBe("ab"); // form feed stripped
		expect(escapeInline("a\x1Fb")).toBe("ab"); // unit separator stripped
		// Preserved:
		expect(escapeInline("a\tb")).toBe("a\tb"); // tab preserved
		expect(escapeInline("a\nb")).toBe("a\nb"); // LF preserved
		// Printable characters + markdown syntax all pass through:
		expect(escapeInline("**bold** `code` [link](url)")).toBe("**bold** `code` [link](url)");
	});
	test("still preserves the LF from CRLF normalisation before stripping", () => {
		expect(escapeInline("abc\r\ndef")).toBe("abc\ndef");
	});
	test("coerces non-string input via String()", () => {
		expect(escapeInline(42)).toBe("42");
		expect(escapeInline(true)).toBe("true");
	});
});

// ─── replaceBlock ────────────────────────────────────────────────────────

describe("replaceBlock", () => {
	const template =
		"# Header\n\nPreamble.\n\n<!-- catalog:begin -->\nSTALE\n<!-- catalog:end -->\n\nFooter.\n";

	test("replaces the block between markers, preserving preamble + footer", () => {
		const out = replaceBlock(template, "<!-- catalog:begin -->\nFRESH\n<!-- catalog:end -->");
		expect(out).toBe(
			"# Header\n\nPreamble.\n\n<!-- catalog:begin -->\nFRESH\n<!-- catalog:end -->\n\nFooter.\n",
		);
	});

	test("throws when begin marker is missing", () => {
		expect(() => replaceBlock("# no markers", "block")).toThrow(/missing.*markers/i);
	});

	test("throws when end marker is missing", () => {
		expect(() => replaceBlock("# only begin\n<!-- catalog:begin -->", "block")).toThrow(
			/missing.*markers/i,
		);
	});

	test("throws when end appears before begin (reversed markers)", () => {
		const reversed = "# hd\n<!-- catalog:end -->\n\nbetween\n\n<!-- catalog:begin -->\n";
		expect(() => replaceBlock(reversed, "block")).toThrow(/missing.*markers/i);
	});
});

// ─── renderRepoCard + renderBlock ───────────────────────────────────────

describe("renderRepoCard", () => {
	const owner = "kaelys-js";
	const baseCatalog = {
		name: "alpha",
		tagline: "A sample project.",
		sellMe: "It does the thing you want.",
		status: "beta",
	};
	const baseMetadata = {
		description: null,
		topics: [],
		primaryLanguage: null,
		visibility: null,
		license: null,
		htmlUrl: null,
	};

	test("renders name + status badge + tagline + sellMe (required fields only)", () => {
		const lines = renderRepoCard(owner, baseCatalog, baseMetadata);
		expect(lines).toContain(`### [alpha](https://github.com/${owner}/alpha)  \`beta\``);
		expect(lines).toContain("_A sample project._");
		expect(lines).toContain("It does the thing you want.");
	});

	test("skips <dl> entirely when no optional facts exist", () => {
		const rendered = renderRepoCard(owner, baseCatalog, baseMetadata).join("\n");
		expect(rendered).not.toContain("<dl>");
	});

	test("renders <dl> with every optional field when present", () => {
		const catalog = {
			...baseCatalog,
			since: 2024,
			primaryLanguage: "TypeScript",
			technology: ["Node.js", "Vitest"],
			topics: ["fixture", "sample"],
		};
		const metadata = {
			...baseMetadata,
			visibility: "public",
			license: "MIT",
			topics: ["ignored-fallback"],
		};
		const rendered = renderRepoCard(owner, catalog, metadata).join("\n");
		expect(rendered).toContain("<dl>");
		expect(rendered).toContain("<dt>Since</dt><dd>2024</dd>");
		expect(rendered).toContain("<dt>Language</dt><dd>TypeScript</dd>");
		expect(rendered).toContain("<dt>Visibility</dt><dd>public</dd>");
		expect(rendered).toContain("<dt>License</dt><dd>MIT</dd>");
		expect(rendered).toContain("<dt>Stack</dt><dd>Node.js, Vitest</dd>");
		// Catalog topics win over metadata.topics fallback.
		expect(rendered).toContain("<dt>Topics</dt><dd>`fixture` `sample`</dd>");
	});

	test("falls back to metadata primaryLanguage when catalog is missing it", () => {
		const catalog = { ...baseCatalog };
		const metadata = { ...baseMetadata, primaryLanguage: "Rust" };
		expect(renderRepoCard(owner, catalog, metadata).join("\n")).toContain(
			"<dt>Language</dt><dd>Rust</dd>",
		);
	});

	test("falls back to metadata topics when catalog topics are empty", () => {
		const catalog = { ...baseCatalog, topics: [] };
		const metadata = { ...baseMetadata, topics: ["a", "b"] };
		expect(renderRepoCard(owner, catalog, metadata).join("\n")).toContain(
			"<dt>Topics</dt><dd>`a` `b`</dd>",
		);
	});

	test("uses metadata.htmlUrl when present, else synthesises a github URL", () => {
		const meta = { ...baseMetadata, htmlUrl: "https://forge.example/alpha" };
		expect(renderRepoCard(owner, baseCatalog, meta).join("\n")).toContain(
			"[alpha](https://forge.example/alpha)",
		);
	});

	test("renders the products section when products exist", () => {
		const catalog = {
			...baseCatalog,
			products: [
				{ name: "alpha-core", description: "The core lib." },
				{ name: "alpha-cli", description: "The CLI." },
			],
		};
		const rendered = renderRepoCard(owner, catalog, baseMetadata).join("\n");
		expect(rendered).toContain("**Products**");
		expect(rendered).toContain("- `alpha-core` — The core lib.");
		expect(rendered).toContain("- `alpha-cli` — The CLI.");
	});

	test("skips products section when catalog.products is empty", () => {
		const catalog = { ...baseCatalog, products: [] };
		expect(renderRepoCard(owner, catalog, baseMetadata).join("\n")).not.toContain("**Products**");
	});

	test("renders links in the fixed order (homepage → discussions), skipping missing keys", () => {
		const catalog = {
			...baseCatalog,
			links: {
				discussions: "https://d.example",
				homepage: "https://h.example",
				releases: "https://r.example",
				// docs + issues omitted; they must not render as empty
			},
		};
		const rendered = renderRepoCard(owner, catalog, baseMetadata).join("\n");
		// Fixed order: homepage first, releases second, discussions last.
		const linkLine = rendered.split("\n").find((l) => l.includes("[homepage]"));
		expect(linkLine).toBe(
			"[homepage](https://h.example) · [releases](https://r.example) · [discussions](https://d.example)",
		);
		expect(rendered).not.toContain("[docs]");
		expect(rendered).not.toContain("[issues]");
	});

	test("skips links block entirely when links is empty", () => {
		const catalog = { ...baseCatalog, links: {} };
		expect(renderRepoCard(owner, catalog, baseMetadata).join("\n")).not.toContain("·");
	});

	test("skips links block when NO known keys exist (only unknown ones)", () => {
		const catalog = { ...baseCatalog, links: { random: "https://x" } };
		expect(renderRepoCard(owner, catalog, baseMetadata).join("\n")).not.toMatch(/\[random\]/);
	});

	test("falls back to raw status when not in STATUS_BADGE (defensive)", () => {
		// The schema restricts status to the STATUS_BADGE keys, but the
		// renderer's fallback handles a future value gracefully.
		const catalog = { ...baseCatalog, status: "future-value" };
		expect(renderRepoCard(owner, catalog, baseMetadata).join("\n")).toContain("`future-value`");
	});
});

describe("renderBlock", () => {
	test("wraps every entry with markers + regeneration warning + blank spacing", () => {
		const entries = [
			{
				catalog: { name: "a", tagline: "T", sellMe: "S", status: "beta" },
				metadata: { htmlUrl: null, topics: [] },
			},
			{
				catalog: { name: "b", tagline: "T2", sellMe: "S2", status: "alpha" },
				metadata: { htmlUrl: null, topics: [] },
			},
		];
		const block = renderBlock("kaelys-js", entries);
		expect(block.startsWith(BEGIN_MARKER)).toBe(true);
		expect(block.endsWith(END_MARKER)).toBe(true);
		expect(block).toContain("do not hand-edit inside these markers");
		expect(block).toContain("### [a]");
		expect(block).toContain("### [b]");
	});

	test("empty entries still produces a valid empty block", () => {
		const block = renderBlock("kaelys-js", []);
		expect(block).toContain(BEGIN_MARKER);
		expect(block).toContain(END_MARKER);
		expect(block).toContain("do not hand-edit");
	});
});

// ─── loadValidator ───────────────────────────────────────────────────────

describe("loadValidator", () => {
	test("returns a validator that passes a valid catalog", async () => {
		const assertValid = await loadValidator(SCHEMA);
		expect(() =>
			assertValid("alpha", {
				name: "alpha",
				tagline: "Ten-plus chars for min",
				sellMe: "This sellMe is at least forty characters long to satisfy the schema.",
				status: "beta",
			}),
		).not.toThrow();
	});

	test("returned validator throws on a missing required field", async () => {
		const assertValid = await loadValidator(SCHEMA);
		expect(() => assertValid("bad", { name: "bad" })).toThrow(/is invalid/);
	});

	test("error message includes the field path for triage", async () => {
		const assertValid = await loadValidator(SCHEMA);
		try {
			assertValid("bad", { name: "bad" });
			throw new Error("expected throw");
		} catch (e) {
			expect(e.message).toMatch(/tagline|sellMe|status/);
		}
	});
});

// ─── githubFetch ─────────────────────────────────────────────────────────

describe("githubFetch", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("passes bearer auth when a token is provided", async () => {
		fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
		await githubFetch("https://api.example/x", "TOKEN_ABC");
		const call = fetch.mock.calls[0];
		expect(call[1].headers.authorization).toBe("Bearer TOKEN_ABC");
	});

	test("omits authorization when token is falsy", async () => {
		fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
		await githubFetch("https://api.example/x", "");
		const call = fetch.mock.calls[0];
		expect(call[1].headers.authorization).toBeUndefined();
	});

	test("throws on non-2xx with url + status + body prefix", async () => {
		fetch.mockResolvedValueOnce({
			ok: false,
			status: 403,
			text: async () => "forbidden",
		});
		await expect(githubFetch("https://api.example/x", "T")).rejects.toThrow(/403.*forbidden/);
	});

	test("returns the parsed JSON body on success", async () => {
		fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ hello: "world" }) });
		expect(await githubFetch("https://api.example/x", "T")).toEqual({ hello: "world" });
	});
});

// ─── fetchCatalogFromGitHub ──────────────────────────────────────────────

describe("fetchCatalogFromGitHub", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("decodes base64 content and returns the parsed catalog", async () => {
		const catalog = { name: "alpha", tagline: "t", sellMe: "s", status: "beta" };
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				encoding: "base64",
				content: Buffer.from(JSON.stringify(catalog)).toString("base64"),
			}),
		});
		expect(await fetchCatalogFromGitHub("kaelys-js", "alpha", "T")).toEqual(catalog);
	});

	test("throws when /contents response is the wrong shape", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ encoding: "utf8", content: "raw text" }),
		});
		await expect(fetchCatalogFromGitHub("kaelys-js", "alpha", "T")).rejects.toThrow(
			/Unexpected \/contents response shape/,
		);
	});
});

// ─── fetchMetadataFromGitHub ─────────────────────────────────────────────

describe("fetchMetadataFromGitHub", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("maps every documented field, sorts topics, filters NOASSERTION license", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				description: "desc",
				topics: ["z-topic", "a-topic", "m-topic"],
				language: "TypeScript",
				visibility: "public",
				license: { spdx_id: "MIT" },
				html_url: "https://github.com/kaelys-js/alpha",
			}),
		});
		const md = await fetchMetadataFromGitHub("kaelys-js", "alpha", "T");
		expect(md).toEqual({
			description: "desc",
			topics: ["a-topic", "m-topic", "z-topic"],
			primaryLanguage: "TypeScript",
			visibility: "public",
			license: "MIT",
			htmlUrl: "https://github.com/kaelys-js/alpha",
		});
	});

	test("NOASSERTION license maps to null", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				description: null,
				topics: [],
				language: null,
				visibility: "private",
				license: { spdx_id: "NOASSERTION" },
				html_url: "https://github.com/kaelys-js/alpha",
			}),
		});
		expect((await fetchMetadataFromGitHub("kaelys-js", "alpha", "T")).license).toBe(null);
	});

	test("missing license object maps to null", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				description: null,
				topics: [],
				language: null,
				visibility: "public",
				license: null,
				html_url: "https://github.com/kaelys-js/alpha",
			}),
		});
		expect((await fetchMetadataFromGitHub("kaelys-js", "alpha", "T")).license).toBe(null);
	});

	test("visibility falls back to private/public based on `private` bool", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				description: null,
				topics: [],
				language: null,
				visibility: null,
				private: true,
				license: null,
				html_url: "https://github.com/x/y",
			}),
		});
		expect((await fetchMetadataFromGitHub("x", "y", "T")).visibility).toBe("private");

		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				description: null,
				topics: [],
				language: null,
				visibility: null,
				private: false,
				license: null,
				html_url: "https://github.com/x/y",
			}),
		});
		expect((await fetchMetadataFromGitHub("x", "y", "T")).visibility).toBe("public");
	});

	test("non-array topics coerces to []", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				description: null,
				topics: "not-an-array",
				language: null,
				visibility: "public",
				license: null,
				html_url: "https://github.com/x/y",
			}),
		});
		expect((await fetchMetadataFromGitHub("x", "y", "T")).topics).toEqual([]);
	});

	test("null description passes through as null", async () => {
		fetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				description: undefined,
				topics: [],
				language: null,
				visibility: "public",
				license: null,
				html_url: "https://github.com/x/y",
			}),
		});
		expect((await fetchMetadataFromGitHub("x", "y", "T")).description).toBe(null);
	});
});

// ─── loadFromFixtures ────────────────────────────────────────────────────

describe("loadFromFixtures", () => {
	let scratch;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "sync-catalog-lff-"));
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	test("reads and parses both catalog + metadata files", async () => {
		writeFileSync(join(scratch, "myrepo-catalog.json"), JSON.stringify({ name: "myrepo" }));
		writeFileSync(join(scratch, "myrepo-metadata.json"), JSON.stringify({ visibility: "public" }));
		const { catalog, metadata } = await loadFromFixtures(scratch, "kaelys-js", "myrepo");
		expect(catalog).toEqual({ name: "myrepo" });
		expect(metadata).toEqual({ visibility: "public" });
	});

	test("throws when catalog file is missing", async () => {
		await expect(loadFromFixtures(scratch, "kaelys-js", "absent")).rejects.toThrow();
	});
});

// ─── runSchemaCheckOnly ──────────────────────────────────────────────────

describe("runSchemaCheckOnly", () => {
	test("walks the fixtures dir + skips absent sibling repos", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await runSchemaCheckOnly({
			reposRoot: join(HERE, "no-such-dir"),
			schemaPath: SCHEMA,
			reposConfigPath: REPOS_CONFIG,
		});
		expect(write).toHaveBeenCalledWith(expect.stringMatching(/schema-check-only OK/));
		write.mockRestore();
	});

	test("defaults reposRoot to the parent of REPO_ROOT when unset", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await runSchemaCheckOnly({
			reposRoot: null,
			schemaPath: SCHEMA,
			reposConfigPath: REPOS_CONFIG,
		});
		// It doesn't fail: sibling repos may or may not exist; only the fixture
		// walk is required to run — no crash.
		expect(write).toHaveBeenCalled();
		write.mockRestore();
	});

	test("throws when a fixture catalog is schema-invalid", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "sync-catalog-bad-"));
		const fx = join(scratch, "tests", "fixtures");
		mkdirSync(fx, { recursive: true });
		writeFileSync(join(fx, "broken-catalog.json"), JSON.stringify({ name: "broken" }));

		// runSchemaCheckOnly reads from REPO_ROOT/tests/fixtures; we need an
		// isolated fixtures dir. Use a distinct reposConfig pointing at zero
		// sibling repos and a schema+reposRoot referencing our scratch dir.
		writeFileSync(join(scratch, "repos.json"), JSON.stringify({ owner: "x", repos: [] }));

		// The function's fixturesDir is fixed to REPO_ROOT/tests/fixtures, so
		// this variant walks the REAL repo's fixtures — which are valid — plus
		// the config. To hit the throw path we need to place an invalid file
		// under REPO_ROOT/tests/fixtures OR pass a config that names a repo
		// whose sibling checkout contains an invalid catalog.
		const badSibling = join(scratch, "sibling", ".github");
		mkdirSync(badSibling, { recursive: true });
		writeFileSync(
			join(badSibling, "kaelys-catalog.json"),
			JSON.stringify({ name: "sibling" }), // missing required fields
		);
		writeFileSync(
			join(scratch, "repos.json"),
			JSON.stringify({ owner: "kaelys-js", repos: ["sibling"] }),
		);

		await expect(
			runSchemaCheckOnly({
				reposRoot: scratch,
				schemaPath: SCHEMA,
				reposConfigPath: join(scratch, "repos.json"),
			}),
		).rejects.toThrow(/is invalid/);

		rmSync(scratch, { recursive: true, force: true });
	});
});

// ─── main (unit — mocked deps) ───────────────────────────────────────────

describe("main", () => {
	let scratch;
	let readmePath;
	const template = "# t\n\n<!-- catalog:begin -->\nSTALE\n<!-- catalog:end -->\n\nfooter\n";

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "sync-catalog-main-"));
		readmePath = join(scratch, "README.md");
		writeFileSync(readmePath, template);
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	test("--schema-check-only branch delegates without needing GITHUB_TOKEN", async () => {
		const argv = [
			"_",
			"_",
			"--schema-check-only",
			`--schema=${SCHEMA}`,
			`--repos-config=${REPOS_CONFIG}`,
			`--repos-root=${join(HERE, "no-such-dir")}`,
		];
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const origArgv = process.argv;
		process.argv = argv;
		await main();
		process.argv = origArgv;
		expect(write).toHaveBeenCalledWith(expect.stringMatching(/schema-check-only OK/));
		write.mockRestore();
	});

	test("--from-fixtures + --check with drift exits non-zero without writing", async () => {
		const argv = [
			"_",
			"_",
			`--from-fixtures=${FIXTURES}`,
			`--repos-config=${REPOS_CONFIG}`,
			`--schema=${SCHEMA}`,
			`--readme=${readmePath}`,
			"--check",
		];
		const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("__exit__");
		});
		const origArgv = process.argv;
		process.argv = argv;
		await expect(main()).rejects.toThrow("__exit__");
		process.argv = origArgv;
		expect(errWrite).toHaveBeenCalledWith(expect.stringMatching(/would change/));
		expect(exit).toHaveBeenCalledWith(1);
		expect(readFileSync(readmePath, "utf8")).toBe(template);
		errWrite.mockRestore();
		exit.mockRestore();
	});

	test("--from-fixtures without --check writes the rendered README", async () => {
		const argv = [
			"_",
			"_",
			`--from-fixtures=${FIXTURES}`,
			`--repos-config=${REPOS_CONFIG}`,
			`--schema=${SCHEMA}`,
			`--readme=${readmePath}`,
		];
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const origArgv = process.argv;
		process.argv = argv;
		await main();
		process.argv = origArgv;
		expect(readFileSync(readmePath, "utf8")).not.toBe(template);
		expect(write).toHaveBeenCalledWith(expect.stringMatching(/rewrote README\.md/));
		write.mockRestore();
	});

	test("main is a no-op on unchanged inputs and logs 'up to date'", async () => {
		// First run writes it; second run should be a no-op.
		const argv = [
			"_",
			"_",
			`--from-fixtures=${FIXTURES}`,
			`--repos-config=${REPOS_CONFIG}`,
			`--schema=${SCHEMA}`,
			`--readme=${readmePath}`,
		];
		const origArgv = process.argv;
		process.argv = argv;
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main();
		// Now the file is up to date; re-running should log "already up to date".
		await main();
		process.argv = origArgv;
		const calls = write.mock.calls.map((c) => c[0]);
		expect(calls.some((c) => /already up to date/.test(c))).toBe(true);
		write.mockRestore();
	});

	test("main fails loud without --from-fixtures and no GITHUB_TOKEN", async () => {
		const argv = [
			"_",
			"_",
			`--repos-config=${REPOS_CONFIG}`,
			`--schema=${SCHEMA}`,
			`--readme=${readmePath}`,
		];
		const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("__exit__");
		});
		const origArgv = process.argv;
		const origToken = process.env.GITHUB_TOKEN;
		process.argv = argv;
		process.env.GITHUB_TOKEN = "";
		await expect(main()).rejects.toThrow("__exit__");
		process.argv = origArgv;
		if (origToken === undefined) delete process.env.GITHUB_TOKEN;
		else process.env.GITHUB_TOKEN = origToken;
		expect(err).toHaveBeenCalledWith(expect.stringMatching(/GITHUB_TOKEN/));
		expect(exit).toHaveBeenCalledWith(1);
		err.mockRestore();
		exit.mockRestore();
	});

	test("main throws when catalog name doesn't match repo slug", async () => {
		// Reuse alpha-catalog.json but register it under a wrong slug.
		const scratch2 = mkdtempSync(join(tmpdir(), "sync-catalog-mm-"));
		mkdirSync(join(scratch2, "fixtures"), { recursive: true });
		const cat = readFileSync(join(FIXTURES, "alpha-catalog.json"), "utf8");
		const md = readFileSync(join(FIXTURES, "alpha-metadata.json"), "utf8");
		writeFileSync(join(scratch2, "fixtures", "wrong-catalog.json"), cat);
		writeFileSync(join(scratch2, "fixtures", "wrong-metadata.json"), md);
		writeFileSync(
			join(scratch2, "repos.json"),
			JSON.stringify({ owner: "kaelys-js", repos: ["wrong"] }),
		);
		const rp = join(scratch2, "README.md");
		writeFileSync(rp, template);
		const argv = [
			"_",
			"_",
			`--from-fixtures=${join(scratch2, "fixtures")}`,
			`--repos-config=${join(scratch2, "repos.json")}`,
			`--schema=${SCHEMA}`,
			`--readme=${rp}`,
		];
		const origArgv = process.argv;
		process.argv = argv;
		await expect(main()).rejects.toThrow(/name.*must match the repo slug/);
		process.argv = origArgv;
		rmSync(scratch2, { recursive: true, force: true });
	});
});
