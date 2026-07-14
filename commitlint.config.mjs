// Conventional commits for kaelys-js. Enforced on commit-msg via
// lefthook + `pnpm lint:commit`.

export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		"type-enum": [
			2,
			"always",
			[
				"feat",
				"fix",
				"docs",
				"style",
				"refactor",
				"perf",
				"test",
				"build",
				"ci",
				"chore",
				"revert",
				"wip",
			],
		],
		"scope-case": [2, "always", "kebab-case"],
		"subject-case": [0],
		"subject-max-length": [0],
		"header-max-length": [0],
		"body-max-line-length": [0],
		"footer-max-line-length": [0],
	},
};
