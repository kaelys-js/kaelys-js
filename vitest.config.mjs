// Vitest configuration for kaelys-js.
//
// One config drives both unit and integration tests. Coverage is measured on
// scripts/*.mjs; the coverage gate matches foundation-registry: ≥90% on
// lines/functions/branches/statements, with per-file thresholds so a
// well-covered file can't mask an under-covered one.
//
// The gate is vitest's own exit code — there is no external assert-script.
// `coverage.all: true` makes an untested file in the include glob count as
// 0% (v8 default) rather than being skipped, so a missing test can't hide.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		globals: false,
		pool: "forks",
		isolate: true,
		passWithNoTests: false,
		include: ["tests/**/*.test.mjs"],
		coverage: {
			provider: "v8",
			reporter: ["text", "text-summary", "json-summary", "lcov", "html"],
			reportsDirectory: "coverage",
			all: true,
			include: ["scripts/**/*.mjs"],
			// The sync-catalog.mjs auto-run guard + main-catch wrapper is process
			// bootstrap glue, not testable behaviour. Every function it wraps is
			// exported + covered individually. Guarded via /* c8 ignore */ blocks
			// in the source; this doesn't waive the thresholds below.
			perFile: true,
			thresholds: {
				lines: 90,
				functions: 90,
				branches: 90,
				statements: 90,
			},
		},
	},
});
